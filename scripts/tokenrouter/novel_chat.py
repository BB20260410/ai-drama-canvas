#!/usr/bin/env python3
"""本 Cloud 最小实现：只支持 --role tr → TokenRouter。禁止打官方千问 / 火山 / OpenAI。"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ENV_LOCAL = Path.home() / ".grok" / "env.local"
ENDPOINT = "https://api.tokenrouter.com/v1/chat/completions"
MODEL = "qwen/qwen3.8-max-free"


def load_env_local() -> None:
    if not ENV_LOCAL.is_file():
        return
    raw = subprocess.check_output(
        ["bash", "-lc", f"set -a && source {ENV_LOCAL.as_posix()} && set +a && printf '%s' \"${{TOKENROUTER_API_KEY:-}}\""],
        text=True,
    )
    if raw and "TOKENROUTER_API_KEY" not in os.environ:
        os.environ["TOKENROUTER_API_KEY"] = raw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", required=True)
    parser.add_argument("--prompt")
    parser.add_argument("--file")
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--meta")
    parser.add_argument("--temperature", type=float)
    parser.add_argument("--top-p", type=float)
    parser.add_argument("--timeout-sec", type=float, default=0)
    args = parser.parse_args()
    if args.role != "tr":
        print("这个副本只实现 --role tr（TokenRouter）。不要改打官方通道。", file=sys.stderr)
        return 2
    if args.prompt and args.file:
        print("--prompt 与 --file 不能同时用。", file=sys.stderr)
        return 2
    if args.file:
        prompt = Path(args.file).read_text(encoding="utf-8")
    elif args.prompt:
        prompt = args.prompt
    else:
        print("需要 --prompt 或 --file。", file=sys.stderr)
        return 2

    load_env_local()
    key = os.environ.get("TOKENROUTER_API_KEY", "").strip()
    if not key:
        print("TOKENROUTER_API_KEY 未注入。从本机 ~/.grok/env.local 填到 Cloud Secret，不要贴进对话。", file=sys.stderr)
        return 2

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
    }
    if args.temperature is not None:
        payload["temperature"] = args.temperature
    if args.top_p is not None:
        payload["top_p"] = args.top_p

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error = ""
    started = time.time()
    for attempt in range(1, 4):
        req = Request(
            ENDPOINT,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw)
                text = data["choices"][0]["message"]["content"]
                Path(args.output).write_text(text, encoding="utf-8")
                if args.meta:
                    Path(args.meta).write_text(
                        json.dumps(
                            {
                                "role": "tr",
                                "model": MODEL,
                                "attempt": attempt,
                                "durationSec": round(time.time() - started, 3),
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                sys.stdout.write(text)
                return 0
        except HTTPError as error:
            last_error = error.read().decode("utf-8", errors="replace")
            if error.code != 500 and "do_request_failed" not in last_error:
                print(f"TokenRouter HTTP {error.code}", file=sys.stderr)
                print(last_error[:500], file=sys.stderr)
                return 1
        except URLError as error:
            last_error = str(error)
        if attempt < 3:
            time.sleep(2)
    print(f"TokenRouter 失败（已重试）。{last_error[:300]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
