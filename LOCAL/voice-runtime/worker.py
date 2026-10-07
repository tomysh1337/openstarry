"""Private JSON-lines process. Audio and transcripts stay in memory, never logs."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import traceback

protocol_out = sys.stdout
# Upstream libraries print input text; discard their output rather than logging it.
quiet = open(os.devnull, 'w', encoding='utf-8')


def reply(value):
    protocol_out.write(json.dumps(value, ensure_ascii=False) + '\n')
    protocol_out.flush()


class VoiceEngine:
    def __init__(self, root):
        self.root = root
        self.gsv = root / 'gpt-sovits'
        os.chdir(self.gsv)
        sys.path[:0] = [str(self.gsv), str(self.gsv / 'GPT_SoVITS'), str(self.gsv / 'GPT_SoVITS/eres2net')]
        os.environ.update(G2PW='0', NLTK_DATA=str(root / 'nltk_data'), HF_HUB_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
        os.environ['PATH'] = str(self.gsv / 'runtime') + os.pathsep + os.environ.get('PATH', '')
        import torch
        torch.set_num_threads(min(6, os.cpu_count() or 4))
        # jieba-fast has no Windows wheel and requires MSVC. The upstream jieba
        # API supplies the same tokenizer/POS interface without a system compiler.
        import jieba
        import jieba.posseg
        sys.modules['jieba_fast'] = jieba
        sys.modules['jieba_fast.posseg'] = jieba.posseg
        from faster_whisper import WhisperModel
        self.device = 'cuda' if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] >= 2 * 1024**3 else 'cpu'
        # CTranslate2 on CPU avoids a second GPU runtime and leaves VRAM for TTS/LLM.
        self.asr = WhisperModel(str(root / 'asr'), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
        self.tts = None
        self.preset = None
        self.load_tts('laomushi')
        # Load pronunciation resources and compile kernels before announcing ready.
        self.synthesize({'text': '你好。', 'preset': 'laomushi'})

    def load_tts(self, preset):
        if self.preset == preset:
            return
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
        base = self.gsv / 'GPT_SoVITS/pretrained_models'
        weights = self.root / 'laomushi/weights'
        gpt = weights / 'laomushi-e20.ckpt' if preset == 'laomushi' else base / 'gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'
        sovits = weights / 'laomushi_v2_e16.pth' if preset == 'laomushi' else base / 'gsv-v2final-pretrained/s2G2333k.pth'
        if self.tts is None:
            cfg = TTS_Config({'custom': {'device': self.device, 'is_half': self.device == 'cuda', 'version': 'v2',
                't2s_weights_path': str(gpt), 'vits_weights_path': str(sovits),
                'bert_base_path': str(base / 'chinese-roberta-wwm-ext-large'),
                'cnhuhbert_base_path': str(base / 'chinese-hubert-base')}})
            self.tts = TTS(cfg)
        else:
            self.tts.init_t2s_weights(str(gpt))
            self.tts.init_vits_weights(str(sovits))
        self.preset = preset

    def transcribe(self, audio):
        raw = base64.b64decode(audio, validate=True)
        if len(raw) > 3 * 1024 * 1024:
            raise ValueError('录音过长，请分段说话')
        segments, _info = self.asr.transcribe(io.BytesIO(raw), language='zh', beam_size=3,
            vad_filter=True, condition_on_previous_text=False)
        return {'text': ''.join(segment.text for segment in segments).strip()}

    def synthesize(self, request):
        import numpy as np
        import soundfile as sf
        text = str(request.get('text', '')).strip()
        if not text or len(text) > 500:
            raise ValueError('朗读文本须为 1–500 字符')
        preset = request.get('preset', 'laomushi')
        if preset not in ['laomushi', 'gpt-sovits']:
            raise ValueError('未知音色')
        self.load_tts(preset)
        reference = self.root / 'laomushi/ref/ref.wav' if preset == 'laomushi' else self.root / 'reference.wav'
        if not reference.is_file():
            raise ValueError('请先选择 3–10 秒的参考音频')
        prompt = '今天天气不错，我们一起出去走走吧。' if preset == 'laomushi' else str(request.get('referenceText', '')).strip()
        if not prompt:
            raise ValueError('请填写参考音频中说的话')
        language = request.get('language', 'all_zh')
        if language not in ['all_zh', 'en']:
            raise ValueError('不支持的朗读语言')
        args = {'text': text, 'text_lang': language, 'ref_audio_path': str(reference),
            'prompt_text': prompt, 'prompt_lang': 'all_zh', 'top_k': 15, 'top_p': 1.0,
            'temperature': 1.0, 'speed_factor': max(0.6, min(1.5, float(request.get('speed', 1)))),
            'batch_size': 1, 'text_split_method': 'cut5', 'split_bucket': False, 'parallel_infer': True,
            'fragment_interval': 0.15, 'streaming_mode': False}
        chunks = list(self.tts.run(args))
        if not chunks:
            raise RuntimeError('语音引擎没有返回音频')
        sr = chunks[0][0]
        audio = np.concatenate([chunk for _rate, chunk in chunks])
        if len(audio) == 0:
            raise RuntimeError('语音引擎返回空音频')
        output = io.BytesIO()
        sf.write(output, audio, sr, format='WAV', subtype='PCM_16')
        return {'audio': base64.b64encode(output.getvalue()).decode('ascii'), 'sampleRate': sr,
            'seconds': len(audio) / sr}

    def reference(self, audio):
        import soundfile as sf
        raw = base64.b64decode(audio, validate=True)
        if len(raw) > 20 * 1024 * 1024:
            raise ValueError('参考音频超过 20 MB')
        data, sr = sf.read(io.BytesIO(raw))
        seconds = len(data) / sr
        if not 3 <= seconds <= 10:
            raise ValueError('参考音频必须为 3–10 秒')
        if data.ndim > 1:
            data = data.mean(axis=1)
        sf.write(self.root / 'reference.wav', data, sr, subtype='PCM_16')
        return {'seconds': seconds}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    root = parser.parse_args().root.resolve()
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        engine = VoiceEngine(root)
    reply({'event': 'ready', 'device': engine.device})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                op = request.get('op')
                if op == 'transcribe':
                    result = engine.transcribe(request['audio'])
                elif op == 'synthesize':
                    result = engine.synthesize(request)
                elif op == 'reference':
                    result = engine.reference(request['audio'])
                else:
                    raise ValueError('Unknown voice operation')
            reply({'id': request['id'], 'result': result})
        except Exception as error:
            reply({'id': request.get('id'), 'error': str(error)[:500]})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reply({'event': 'fatal', 'error': str(error)[:700]})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
