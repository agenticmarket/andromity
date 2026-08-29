import asyncio
import click


@click.group(invoke_without_command=True)
@click.pass_context
def main(ctx):
    """Andromity — The coding agent that never clocks out.

    Run without arguments to launch the interactive TUI.
    """
    if ctx.invoked_subcommand is None:
        # No subcommand given — launch TUI directly
        _launch_tui()


def _launch_tui():
    from andromity.telemetry import maybe_ping
    maybe_ping()

    from rich.console import Console
    console = Console()
    print("""

 █████╗ ███╗   ██╗██████╗ ██████╗  ██████╗ ███╗   ███╗██╗████████╗██╗   ██╗
██╔══██╗████╗  ██║██╔══██╗██╔══██╗██╔═══██╗████╗ ████║██║╚══██╔══╝╚██╗ ██╔╝
███████║██╔██╗ ██║██║  ██║██████╔╝██║   ██║██╔████╔██║██║   ██║    ╚████╔╝ 
██╔══██║██║╚██╗██║██║  ██║██╔══██╗██║   ██║██║╚██╔╝██║██║   ██║     ╚██╔╝  
██║  ██║██║ ╚████║██████╔╝██║  ██║╚██████╔╝██║ ╚═╝ ██║██║   ██║      ██║   
╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝   ╚═╝      ╚═╝                                                                   
    A terminal AI coding agent. Autonomous by choice, gated by trust.
    
    """)
    with console.status("[bold cyan]✦ Starting Andromity...[/bold cyan]", spinner="dots12"):
        from andromity.tui.app import AndromityApp
        app = AndromityApp()
    app.run()


@main.command()
@click.argument("prompt", required=False)
@click.option("--file", "-f", type=click.Path(exists=True), help="Read prompt from file")
@click.option("--yes", is_flag=True, help="Auto-approve all actions")
@click.option("--dry-run", is_flag=True, help="Preview actions without executing")
@click.option("--profile", type=str, default="builder", help="Agent profile to use")
def run(prompt, file, yes, dry_run, profile):
    """Headless single-task mode."""
    if file:
        with open(file, "r", encoding="utf-8") as f:
            prompt = f.read()
    if not prompt:
        raise click.UsageError("Must provide PROMPT or --file")
    asyncio.run(_run_async(prompt, yes, dry_run, profile))


@main.command()
def tui():
    """Launch the interactive TUI (same as running `andromity` with no args)."""
    _launch_tui()


@main.command(name="update")
def update_cmd():
    """Check for updates and upgrade Andromity to the latest version."""
    from andromity.core.updater import check_for_updates_sync, perform_update
    from andromity import __version__

    click.echo(f"Current version: v{__version__}")
    click.echo("Checking for updates...")
    info = check_for_updates_sync(force=True)
    latest = info.get("latest_version")
    if not info.get("update_available"):
        click.secho(f"✓ Andromity is up to date (v{__version__})", fg="green")
        return

    click.secho(f"Found new version: v{latest}! Upgrading now...", fg="cyan")
    ok, msg = perform_update()
    if ok:
        click.secho(msg, fg="green")
    else:
        click.secho(msg, fg="red")


@main.command(name="install-context-menu")
@click.option("--icon", "-i", type=click.Path(exists=True), help="Optional path to custom .ico icon file")
def install_context_menu_cmd(icon):
    """Add 'Open with Andromity' to the Windows right-click context menu.For better UX"""
    from andromity.core.context_menu import install_context_menu
    ok, msg = install_context_menu(icon_path=icon)
    if ok:
        click.secho(f"✓ {msg}", fg="green")
    else:
        click.secho(f"✗ {msg}", fg="red")


@main.command(name="uninstall-context-menu")
def uninstall_context_menu_cmd():
    """Remove 'Open with Andromity' from the Windows right-click context menu."""
    from andromity.core.context_menu import remove_context_menu
    ok, msg = remove_context_menu()
    if ok:
        click.secho(f"✓ {msg}", fg="green")
    else:
        click.secho(f"✗ {msg}", fg="red")



async def _run_async(prompt, yes, dry_run, profile):
    from pathlib import Path
    from andromity.config import config
    if yes:
        config.set_trusted(str(Path.cwd()))
    from andromity.core.session import Session
    from andromity.core.agent import Agent
    from andromity.core.events import TextDelta, ToolCallStart, ToolCallEnd, Done
    from andromity.core.models import get_context_limit_for_model, get_ollama_num_ctx
    session = Session(name="headless-session")
    provider = config.get("default", "provider", "")
    model = config.get("default", "model", "")
    if provider == "ollama":
        ctx_limit = get_ollama_num_ctx(model)
    else:
        ctx_limit = get_context_limit_for_model(provider, model) if (provider and model) else 0

    async def _cli_approval(tool_name: str, args: dict) -> bool:
        import json as _json
        print(f"\n[Approval required] Tool: {tool_name}")
        print(_json.dumps(args, indent=2))
        try:
            answer = input("Allow? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        return answer in ("y", "yes")

    agent = Agent(
        session,
        profile=profile,
        dry_run=dry_run,
        auto_approve=yes,
        on_tool_approval=None if yes else _cli_approval,
        ctx_limit=ctx_limit,
    )
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
