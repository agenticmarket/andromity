import asyncio
import sys
from contextlib import aclosing
import click


@click.group(invoke_without_command=True)
@click.pass_context
def main(ctx):
    """Andromity — The coding agent that never clocks out.

    Run without arguments to launch the interactive TUI.
    """
    from andromity.core.network_policy import activate

    activate()
    if ctx.invoked_subcommand is None:
        # No subcommand given — launch TUI directly
        _launch_tui()


def _launch_tui():
    import os
    os.environ.setdefault("ANDROMITY_CLIENT", "tui")
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
@click.option("--provider", type=str, default=None, help="Provider override")
@click.option("--model", type=str, default=None, help="Model override")
def run(prompt, file, yes, dry_run, profile, provider, model):
    """Headless single-task mode."""
    if file:
        with open(file, "r", encoding="utf-8") as f:
            prompt = f.read()
    if not prompt:
        raise click.UsageError("Must provide PROMPT or --file")
    _tolerate_narrow_console()
    from andromity.telemetry import take_first_run_notice
    notice = take_first_run_notice()
    if notice:
        click.echo(notice, err=True)
    asyncio.run(_run_async(prompt, yes, dry_run, profile, provider, model))


def _tolerate_narrow_console() -> None:
    """Replies and error cards contain symbols a cp1252 console or redirected output cannot encode."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


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


@main.command(name="server")
@click.option("--stdio", is_flag=True, default=True, help="Run JSON-RPC server over stdio (default)")
@click.option("--port", type=int, default=None, help="Run TCP server on specified port")
@click.option("--host", type=str, default="127.0.0.1", help="TCP host to bind")
def server_cmd(stdio, port, host):
    """Launch the JSON-RPC daemon server for VS Code extension, desktop apps, and external clients."""
    import os
    os.environ.setdefault("ANDROMITY_CLIENT", "server")
    from andromity.server.main import start_stdio_server, start_tcp_server
    if port is not None:
        asyncio.run(start_tcp_server(host=host, port=port))
    else:
        asyncio.run(start_stdio_server())


@main.command(name="receipt")
@click.argument("session_id", required=False)
@click.option("--turn", type=click.IntRange(min=1), default=None,
              help="Turn number, 1 for the first. Defaults to the latest finished turn.")
@click.option("--json", "as_json", is_flag=True, help="Print the full receipt as JSON.")
@click.option("--markdown", "as_markdown", is_flag=True, help="Print it as Markdown for a pull request.")
@click.option("--project", type=click.Path(file_okay=False), default=None,
              help="Project folder. Defaults to the current folder.")
def receipt_cmd(session_id, turn, as_json, as_markdown, project):
    """Show what one agent turn read, changed, ran and was stopped from doing."""
    import json
    import os
    from pathlib import Path
    from andromity.config import config
    from andromity.core.identity import local_identity
    from andromity.core.receipt import ReceiptUnavailable, build_receipt, render_markdown, render_text
    from andromity.core.session import Session

    if as_json and as_markdown:
        raise click.UsageError("Choose --json or --markdown, not both.")
    project_path = str(Path(project or os.getcwd()).resolve())
    if session_id:
        session = Session.load_by_id(session_id, project_path)
    else:
        recent = Session.list_sessions(project_path, limit=1)
        session = Session.load_by_id(recent[0].id, project_path) if recent else None
    if session is None:
        raise click.ClickException("No session found for this folder. Run Andromity here first, or pass a session id.")
    if not config.is_trusted(session.project_path):
        raise click.ClickException("Trust this workspace in Andromity to read its receipts.")
    try:
        receipt = build_receipt(session, None if turn is None else turn - 1)
    except ReceiptUnavailable as exc:
        raise click.ClickException(str(exc))
    if as_json:
        _echo_safely(json.dumps(receipt, indent=2, ensure_ascii=False))
    elif as_markdown:
        _echo_safely(render_markdown(receipt))
    else:
        _echo_safely(render_text(receipt, local_identity(session.project_path)))


def _echo_safely(text: str) -> None:
    try:
        click.echo(text)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        click.echo(text.encode(encoding, errors="replace").decode(encoding))



def _maybe_show_feedback_hint():
    try:
        from andromity.config import get_config_dir
        cfg_dir = get_config_dir()
        cfg_dir.mkdir(parents=True, exist_ok=True)
        flag_file = cfg_dir / ".feedback_shown"
        if flag_file.exists():
            return
        flag_file.touch()
        print("\033[2m----------------------------------------------------\033[0m")
        print("\033[2m  Found a bug or have a suggestion? -> https://github.com/agenticmarket/andromity/issues\033[0m")
    except Exception:
        pass


async def _run_async(prompt, yes, dry_run, profile, provider=None, model=None):
    import os
    os.environ.setdefault("ANDROMITY_CLIENT", "cli")
    from pathlib import Path
    from andromity.config import config
    if yes:
        config.set_trusted(str(Path.cwd()))
    from andromity.core.session import Session
    from andromity.core.agent import Agent
    from andromity.core.models import get_context_limit_for_model, get_ollama_num_ctx
    session = Session(name="headless-session")
    provider = provider or config.get("default", "provider", "")
    model = model or config.get("default", "model", "")
    session.provider = provider
    session.model = model
    if provider == "ollama":
        ctx_limit = get_ollama_num_ctx(model)
    else:
        ctx_limit = get_context_limit_for_model(provider, model) if (provider and model) else 0

    async def _cli_approval(tool_name: str, args: dict) -> dict:
        import json as _json
        print(f"\n[Approval required] Tool: {tool_name}")
        print(_json.dumps(args, indent=2))
        try:
            answer = input("Allow? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        return {"approved": answer in ("y", "yes"), "by": "person"}

    agent = Agent(
        session,
        profile=profile,
        dry_run=dry_run,
        auto_approve=yes,
        on_tool_approval=None if yes else _cli_approval,
        ctx_limit=ctx_limit,
        provider=provider,
        model=model,
    )
    pending_calls = {}
    record = await _start_cli_turn(session)

    print(f"\nUser: {prompt}\n")
    print("Andromity:", end=" ", flush=True)
    try:
        await _stream_cli_events(agent, prompt, pending_calls)
    finally:
        receipt = await _finish_cli_turn(session, record)
    print(f"\n\nTokens: {session.token_total} | Cost: ${session.cost_usd:.4f}")
    if receipt is not None:
        count = len(receipt["needs_attention"])
        attention = f"{count} {'thing needs' if count == 1 else 'things need'} your eyes. " if count else ""
        print(f"Receipt: {attention}See what this run read, changed and ran: andromity receipt {session.id}")
    _maybe_show_feedback_hint()


async def _start_cli_turn(session):
    """Snapshot a trusted git project before a headless run, so the run gets a receipt. Never creates a repo."""
    from pathlib import Path
    from andromity.config import config
    from andromity.core.git_ops import create_pre_edit_snapshot, get_repo
    from andromity.core.receipt import start_turn_record
    session.turn_key = None
    project = Path(session.project_path)
    if not config.is_trusted(str(project)) or get_repo(project) is None:
        return None
    snapshot = await asyncio.to_thread(create_pre_edit_snapshot, project)
    return start_turn_record(session, snapshot) if snapshot else None


async def _finish_cli_turn(session, record):
    from pathlib import Path
    from andromity.core.git_ops import create_pre_edit_snapshot
    from andromity.core.receipt import close_turn_record, seal_receipt, turn_started
    if record is None:
        return None
    if not turn_started(session, record):
        session.undo_stack.remove(record)
        return None
    record.update(close_turn_record(session))
    record["after_hash"] = await asyncio.to_thread(create_pre_edit_snapshot, Path(session.project_path))
    try:
        receipt = await asyncio.to_thread(seal_receipt, session, record) if record["after_hash"] else None
    except Exception:
        receipt = None
    session.save()
    return receipt


async def _stream_cli_events(agent, prompt, pending_calls):
    from andromity.core.events import TextDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, ToolResult
    async with aclosing(agent.run(prompt)) as events:
        async for event in events:
            if isinstance(event, TextDelta):
                print(event.text, end="", flush=True)
            elif isinstance(event, ToolCallStart):
                pending_calls[event.tool_id] = {"name": event.tool_name, "args": ""}
            elif isinstance(event, ToolCallDelta):
                if event.tool_id in pending_calls:
                    pending_calls[event.tool_id]["args"] += event.args_json_chunk
            elif isinstance(event, ToolCallEnd):
                call_info = pending_calls.get(event.tool_id, {})
                name = call_info.get("name", "tool")
                args_str = call_info.get("args", "")
                formatted_args = ""
                try:
                    import json
                    parsed = json.loads(args_str)
                    parts = []
                    for k, v in parsed.items():
                        if isinstance(v, str):
                            val_str = v.replace("\n", "\\n")
                            if len(val_str) > 60:
                                val_str = val_str[:57] + "..."
                            parts.append(f'{k}="{val_str}"')
                        elif isinstance(v, (int, float, bool)):
                            parts.append(f'{k}={v}')
                        elif isinstance(v, list):
                            parts.append(f'{k}=[{len(v)} items]')
                        else:
                            parts.append(f'{k}=...')
                    formatted_args = ", ".join(parts)
                except Exception:
                    formatted_args = args_str[:60]
                print(f"\n[Tool: {name}({formatted_args})]", end=" ", flush=True)
            elif isinstance(event, ToolResult):
                status = "Success" if event.success else "Failed"
                dur = f"{event.duration_ms:.0f}ms"
                preview = ""
                if not event.success and event.result:
                    first_line = event.result.strip().split("\n")[0]
                    preview = f" - {first_line[:80]}"
                print(f"-> [{status}, {dur}{preview}]", end=" ", flush=True)


if __name__ == "__main__":
    main()

