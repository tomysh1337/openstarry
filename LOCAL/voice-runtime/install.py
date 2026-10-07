"""Prepare a private, reproducible voice runtime. Invoked by the desktop app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request
import zipfile

GSV_COMMIT = "9bbd80ab33fa5085065164f8378e14e29c3af90f"
LAOMUSHI_COMMIT = "dd37267e938e165760475c485a402158fcc0b259"
GSV_MODELS = "8f8857563c040d542de108a2c18b0425abd6c9c5"
ASR_MODELS = "536b0662742c02347bc0e980a01041f333bce120"
G2PW_MODELS = "0c47645e02a7bc3688d7b263b0042c81e3cd82cd"


def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".download")
    with urllib.request.urlopen(url, timeout=90) as response, temporary.open("wb") as out:
        shutil.copyfileobj(response, out, 1024 * 1024)
    temporary.replace(target)


def source(root, repo, revision, name):
    target = root / name
    if (target / ".revision").is_file() and (target / ".revision").read_text() == revision:
        return target
    archive = root / (name + ".zip")
    print("下载源码：" + repo, flush=True)
    download(f"https://api.github.com/repos/{repo}/zipball/{revision}", archive)
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            relative = Path(*Path(entry.filename).parts[1:])
            if not relative.parts or entry.is_dir():
                continue
            destination = (target / relative).resolve()
            if not destination.is_relative_to(target.resolve()):
                raise ValueError("Invalid archive path")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as src, destination.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    (target / ".revision").write_text(revision)
    archive.unlink()
    return target


def prepare(root):
    from huggingface_hub import snapshot_download, hf_hub_download
    import imageio_ffmpeg
    import nltk
    root.mkdir(parents=True, exist_ok=True)
    gsv = source(root, "RVC-Boss/GPT-SoVITS", GSV_COMMIT, "gpt-sovits")
    lao = source(root, "cubk1/laomushi-tts", LAOMUSHI_COMMIT, "laomushi")
    print("下载 GPT-SoVITS 基础模型…", flush=True)
    snapshot_download("lj1995/GPT-SoVITS", revision=GSV_MODELS,
        local_dir=gsv / "GPT_SoVITS/pretrained_models", max_workers=3,
        allow_patterns=["chinese-roberta-wwm-ext-large/*", "chinese-hubert-base/*",
            "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
            "gsv-v2final-pretrained/s2G2333k.pth", "sv/pretrained_eres2netv2w24s4ep4.ckpt"])
    for name, size in [("laomushi-e20.ckpt", 155313312), ("laomushi_v2_e16.pth", 134936883)]:
        target = lao / "weights" / name
        if not target.exists() or target.stat().st_size != size:
            print("下载老牧师音色：" + name, flush=True)
            download("https://github.com/cubk1/laomushi-tts/releases/download/weights1/" + name, target)
        if target.stat().st_size != size:
            raise ValueError("音色文件下载不完整：" + name)
    print("下载本地语音识别模型…", flush=True)
    snapshot_download("Systran/faster-whisper-small", revision=ASR_MODELS,
        local_dir=root / "asr", max_workers=3,
        allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "README.md"])
    g2pw_dir = gsv / "GPT_SoVITS/text/G2PWModel"
    if not (g2pw_dir / ".revision").is_file():
        print("下载中文多音字模型…", flush=True)
        archive = hf_hub_download("XXXXRT/GPT-SoVITS-Pretrained", "G2PWModel.zip", revision=G2PW_MODELS,
            cache_dir=root / "cache/huggingface")
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                parts = Path(entry.filename).parts
                if parts and parts[0].startswith("G2PWModel"):
                    parts = parts[1:]
                if not parts or entry.is_dir():
                    continue
                destination = (g2pw_dir / Path(*parts)).resolve()
                if not destination.is_relative_to(g2pw_dir.resolve()):
                    raise ValueError("Invalid model archive path")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        (g2pw_dir / ".revision").write_text(G2PW_MODELS)
    runtime = gsv / "runtime"
    runtime.mkdir(exist_ok=True)
    shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), runtime / "ffmpeg.exe")
    nltk_dir = root / "nltk_data"
    for name in ["averaged_perceptron_tagger", "averaged_perceptron_tagger_eng", "cmudict"]:
        if not nltk.download(name, download_dir=str(nltk_dir), quiet=True):
            raise RuntimeError("语言资源下载失败：" + name)
    # Mark ready only after every dependency and model is present.
    marker = {"schema": 1, "gsv": GSV_COMMIT, "laomushi": LAOMUSHI_COMMIT,
        "gsvModels": GSV_MODELS, "asrModels": ASR_MODELS, "g2pwModels": G2PW_MODELS,
        "weights": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (lao / "weights").glob("*.*")}}
    (root / "installed.json").write_text(json.dumps(marker, indent=2), encoding="utf-8")
    print("语音组件安装完成", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    prepare(parser.parse_args().root.resolve())
