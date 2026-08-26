#!/usr/bin/env python3
"""本 Cloud 分席代码审查入口。

千问 Token Plan + 方舟 Agent Plan。不写密钥，不打官方 DashScope 按量 / OpenAI / TokenRouter。
默认席：glm 结构审、deepseek 探针、qwen 主审。豆包审查易超时，需 --with-doubao。
主审裁定无 must-fix 时不要按 DeepSeek 去拆 command-bus ledger 或全量异步化 rebuildGraph。
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ENV_LOCAL = Path.home() / ".grok" / "env.local"
ARK_PLAN = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"
QWEN_PLAN = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
DEFAULT_SEATS = ["glm", "deepseek", "qwen"]
ALLOWED_KEY_ENVS = ("ARK_API_KEY", "QWEN_TOKEN_PLAN_API_KEY")

SEATS = {
    "glm": {
        "url": ARK_PLAN,
        "key_env": "ARK_API_KEY",
        "model": "glm-5.3",
        "temperature": 0.3,
        "role": "GLM 结构审校。只出中文问题表，不要英文思考。禁止建议拆 command-bus 写路径或改 T23 SQL。",
    },
    "deepseek": {
        "url": QWEN_PLAN,
        "key_env": "QWEN_TOKEN_PLAN_API_KEY",
        "model": "deepseek-v4-pro",
        "temperature": 0.4,
        "role": "DeepSeek 探针。找反例。禁止虚构文件名。禁止把红线保留当成缺陷。",
    },
    "qwen": {
        "url": QWEN_PLAN,
        "key_env": "QWEN_TOKEN_PLAN_API_KEY",
        "model": "qwen3.8-max-preview",
        "temperature": 0.3,
        "role": "千问主审。综合他席，裁定 must-fix。结论只用已完成/部分完成/阻塞/失败/未开始。无 must-fix 就写无 must-fix。",
    },
    "doubao": {
        "url": ARK_PLAN,
        "key_env": "ARK_API_KEY",
        "model": "doubao-seed-evolving",
        "temperature": 0.5,
        "role": "豆包第二读。指出他席幻觉。只出中文问题表。",
    },
}


def load_env_local() -> None:
    if not ENV_LOCAL.is_file():
        return
    exported = subprocess.check_output(
        [
            "bash",
            "-lc",
            f"set -a && source {shlex.quote(ENV_LOCAL.as_posix())} && set +a && /usr/bin/env",
        ],
        text=True,
    )
    for line in exported.splitlines():
        name, sep, value = line.partition("=")
        if not sep or name not in ALLOWED_KEY_ENVS:
            continue
        os.environ.setdefault(name, value.strip().strip("'\""))


def chat(url: str, key: str, model: str, prompt: str, temperature: float, timeout_sec: float) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
        "temperature": temperature,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    timeout = None if timeout_sec == 0 else timeout_sec
    last_error = ""
    for attempt in range(1, 4):
        req = Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                message = data["choices"][0]["message"]
                text = (message.get("content") or "").strip()
                if not text:
                    text = (message.get("reasoning_content") or "").strip()
                return text
        except HTTPError as error:
            last_error = error.read().decode("utf-8", errors="replace")
            retryable = error.code in {429, 500} or "do_request_failed" in last_error
            if not retryable:
                raise RuntimeError(f"HTTP {error.code}: {last_error[:300]}") from error
        except URLError as error:
            last_error = str(error)
        if attempt < 3:
            time.sleep(2 * attempt)
    raise RuntimeError(f"失败（已重试）。{last_error[:300]}")


def parse_seats(raw: str, with_doubao: bool) -> list[str]:
    seats = [item.strip() for item in raw.split(",") if item.strip()] if raw.strip() else list(DEFAULT_SEATS)
    if with_doubao and "doubao" not in seats:
        seats.append("doubao")
    unknown = [name for name in seats if name not in SEATS]
    if unknown:
        raise SystemExit(f"未知席：{', '.join(unknown)}。允许：{', '.join(SEATS)}")
    return seats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--brief", required=True, help="审查简报文件")
    parser.add_argument("-o", "--output-dir", required=True)
    parser.add_argument("--timeout-sec", type=float, default=120)
    parser.add_argument("--seats", default="", help="逗号分隔：glm,deepseek,qwen,doubao。默认 glm,deepseek,qwen")
    parser.add_argument("--with-doubao", action="store_true")
    args = parser.parse_args()

    brief = Path(args.brief).read_text(encoding="utf-8")
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    load_env_local()
    seats = parse_seats(args.seats, args.with_doubao)

    results: dict[str, object] = {}
    for name in seats:
        spec = SEATS[name]
        key = os.environ.get(str(spec["key_env"]), "").strip()
        if not key:
            results[name] = {"ok": False, "error": f"{spec['key_env']} 未注入"}
            (out_dir / f"{name}.txt").write_text(f"{spec['key_env']} 未注入\n", encoding="utf-8")
            continue
        prompt = f"{spec['role']}\n\n{brief}"
        try:
            text = chat(spec["url"], key, spec["model"], prompt, float(spec["temperature"]), args.timeout_sec)
            (out_dir / f"{name}.txt").write_text(text + "\n", encoding="utf-8")
            results[name] = {"ok": True, "model": spec["model"], "chars": len(text)}
        except Exception as error:
            message = str(error)
            (out_dir / f"{name}.txt").write_text(message + "\n", encoding="utf-8")
            results[name] = {"ok": False, "error": message[:400]}

    (out_dir / "meta.json").write_text(
        json.dumps({"seats": results, "chief": "qwen"}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if "qwen" in seats:
        qwen = results.get("qwen")
        if not isinstance(qwen, dict) or not qwen.get("ok"):
            print("主审 qwen 未成功。", file=sys.stderr)
            return 1
    elif any(not isinstance(item, dict) or not item.get("ok") for item in results.values()):
        print("所选席未全部成功。", file=sys.stderr)
        return 1
    print(f"wrote {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
