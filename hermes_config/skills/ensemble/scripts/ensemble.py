import asyncio, httpx, os, json, sys, argparse

BASE_URL = "https://huixin.nat100.top/v1"
API_KEY = os.environ.get("NAT100_API_KEY", "")

if not API_KEY:
    print("ERROR: NAT100_API_KEY not set", file=sys.stderr)
    sys.exit(1)

MODELS = {
    "engineer_a": "kimi-k2.6",
    "engineer_b": "MiniMax-M3",
    "checker": "glm-5.2",
}


async def call_model(role: str, prompt: str, temp: float = 0.0) -> str:
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            f"{BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={
                "model": MODELS[role],
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temp,
            },
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def ensemble(task_prompt: str, context: str = "") -> dict:
    eng_prompt = (
        "你是 engineer，负责生成完整代码方案。\n"
        "要求：覆盖所有改动点、边界情况、异常处理。不自审不自查。\n\n"
        f"任务：{task_prompt}\n\n上下文：{context}"
    )

    a_task = asyncio.create_task(call_model("engineer_a", eng_prompt))
    b_task = asyncio.create_task(call_model("engineer_b", eng_prompt))
    a, b = await asyncio.gather(a_task, b_task)

    checker_prompt = (
        "你是 checker，对比以下两个方案，综合出一份更完整的最终方案。\n\n"
        "要求：\n"
        "1. 列出每个方案的亮点和遗漏\n"
        "2. 取长补短，综合成一份最优方案\n"
        "3. 标注来源：[A] 来自方案A、[B] 来自方案B、[NEW] 你补充的\n\n"
        f"方案 A：\n{a}\n\n"
        f"方案 B：\n{b}\n\n"
        "请输出综合后的完整方案。"
    )

    synthesis = await call_model("checker", checker_prompt)
    return {"a": a, "b": b, "synthesis": synthesis}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--task", required=True)
    p.add_argument("--context", default="")
    args = p.parse_args()

    result = asyncio.run(ensemble(args.task, args.context))
    print(json.dumps(result, ensure_ascii=False))
