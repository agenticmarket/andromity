import asyncio
import click
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, ToolCallStart, ToolCallEnd, Done


@click.group()
def main():
    """Andromity - The coding agent that never clocks out."""
    pass


@main.command()
@click.argument("prompt")
@click.option("--yes", is_flag=True, help="Auto-approve all actions")
@click.option("--dry-run", is_flag=True, help="Preview actions without executing")
@click.option("--profile", type=str, default="builder", help="Agent profile to use")
def run(prompt, yes, dry_run, profile):
    """Headless single-task mode."""
    asyncio.run(_run_async(prompt, yes, dry_run, profile))


@main.command()
def tui():
    """Launch the interactive TUI."""
    from andromity.tui.app import AndromityApp
    app = AndromityApp()
    app.run()


async def _run_async(prompt, yes, dry_run, profile):
    session = Session(name="headless-session")
    agent = Agent(session, profile=profile, dry_run=dry_run, auto_approve=yes)
    print(f"\nUser: {prompt}\n")
    print("Andromity:", end=" ", flush=True)
    async for event in agent.run(prompt):
        if isinstance(event, TextDelta):
            print(event.text, end="", flush=True)
        elif isinstance(event, ToolCallStart):
            print(f"\n[Tool: {event.tool_name}]", end=" ", flush=True)
        elif isinstance(event, ToolCallEnd):
            print("[Done]", end=" ", flush=True)
    print(f"\n\nTokens: {session.token_total} | Cost: ${session.cost_usd:.4f}")


if __name__ == "__main__":
    main()
