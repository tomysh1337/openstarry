# OpenStarry 本地实时语音

桌面 IDE / Agent 的「开始语音对话」会启动麦克风收音。停顿后本地
Faster-Whisper small 把语音转成文字，文字经过现有 Agent/API 对话链路发送，
GPT-SoVITS 按句合成模型正文并播放。思考内容和代码块不朗读。
播放/识别期间暂停收音；「打断并说话」会取消当前回复和未播放音频，再继续收音。
挂断、切换聊天/项目或离开 IDE 都会释放麦克风。语音入口目前用于桌面 API 聊天。

## 音色

- **老牧师**：使用 cubk1/laomushi-tts 的 GPT、SoVITS 权重和随仓库发布的参考音频。
- **GPT-SoVITS 自定义音色**：使用官方 v2 基础模型；在语音设置里选择 3–10 秒
  WAV/FLAC/OGG 参考音频，并填入对应的中文文本。参考文件经过校验后保存到组件目录。

组件在设置页也可以安装、启动、停止。首次下载约 6 GB，建议预留 20 GB。
Python、缓存、音色模型都位于 `<userData>/components/voice`，随用户数据目录走。
安装器使用应用内置 uv，不要求用户安装终端工具、Python 或 MSVC。
RTX 50 系列使用 PyTorch 2.7.1 / CUDA 12.8；没有兼容 GPU 或可用显存不足 2 GB 时 TTS 使用 CPU，速度会降低。
识别使用 CPU int8，避免占用额外 GPU 运行时。主程序退出时回收它启动的语音进程。

麦克风录音和合成音频通过私有进程管道在内存传递，不写入日志或音频目录。
识别文本会按正常聊天历史保存，并发送给用户选中的模型供应商。
语音合成、识别本身在本机运行。首次安装需要联网下载，安装完成后模型使用本地路径。

## 实现与测试

- `install.py` 固定上游源码、Hugging Face 模型修订，准备环境文件和发音资源。
- `worker.py` 通过 stdin/stdout JSON-lines 协议执行 transcribe/synthesize/reference。
  上游推理日志被抑制，避免把朗读文本写到诊断文件。
- `VoiceManager` 管理安装、进程、配置、请求、退出和失败反馈；不开放网络监听端口。
- Windows 使用纯 Python jieba 兼容上游 jieba-fast 接口，避免引入系统 C++ 编译器。
- 单元测试：`node --test SHARED/workbench/tests/voiceAudio.test.js`。
- 生产 renderer/preload 回归：桌面目录 `npm run build` 后运行
  `node tests/voice.ui.mjs`。该测试使用合成麦克风和服务 fixture，不接触真实麦克风或模型账户。
- 实际模型验收另行运行语音 manager，核对两个音色的 WAV 和本地识别结果；
  不把 fixture 的通过当成真实音色/硬件验证。

## 上游项目与许可

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)，MIT；见 `GPT-SOVITS-LICENSE.txt`。
- [laomushi-tts](https://github.com/cubk1/laomushi-tts)，Unlicense；见 `LAOMUSHI-LICENSE.txt`。
  音色权重来自其 `weights1` release，原始参考音频来自固定仓库修订。
- [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper)，MIT；模型来自
  `Systran/faster-whisper-small`。
- [G2PW](https://github.com/GitYCC/g2pW)，中文多音字模型使用 GPT-SoVITS README 指定来源。
- 下载的 imageio-ffmpeg Windows FFmpeg 二进制按 GPL 发行，其许可可用 `ffmpeg.exe -L` 查看。
  它作为独立程序由上游 GPT-SoVITS 调用；源码和构建信息见
  [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) 与 [FFmpeg](https://ffmpeg.org)。

完整 Python 依赖与模型来源保留在运行目录；不把用户聊天、配置或下载模型塞入应用安装包。
