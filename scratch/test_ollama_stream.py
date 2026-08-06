import asyncio
from litellm import acompletion

async def main():
    response = await acompletion(
        model="ollama_chat/qwen3.5:4b",
        api_base="http://localhost:11434",
        messages=[{"role": "user", "content": "Think step by step and say hi"}],
        stream=True
    )
    async for chunk in response:
        delta = chunk.choices[0].delta
        content = getattr(delta, "content", None)
        thinking = getattr(delta, "thinking", None)
        reasoning = getattr(delta, "reasoning_content", None)
        if content or thinking or reasoning:
            print(f"chunk: content={content!r} thinking={thinking!r} reasoning={reasoning!r}")
        
if __name__ == "__main__":
    asyncio.run(main())
