import asyncio
import tempfile
import time
from pathlib import Path
import pytest
import git
from andromity.server.rpc_handler import JsonRpcHandler

@pytest.mark.asyncio
async def test_diff_numstat_performance_with_large_and_binary_files():
    with tempfile.TemporaryDirectory() as tmpdir:
        repo_dir = Path(tmpdir)
        repo = git.Repo.init(repo_dir)

        # 1. Add tracked file and commit
        f1 = repo_dir / "tracked.txt"
        f1.write_text("line 1\nline 2\n")
        repo.git.add("tracked.txt")
        repo.git.commit("-m", "initial commit")

        # 2. Modify tracked file
        f1.write_text("line 1\nline 2\nline 3\n")

        # 3. Add untracked text file
        f2 = repo_dir / "untracked.py"
        f2.write_text("\n".join(f"print({i})" for i in range(500)) + "\n")

        # 4. Add untracked binary model file (.safetensors)
        f3 = repo_dir / "large_model.safetensors"
        f3.write_bytes(b"0" * 1_500_000)

        # 5. Add untracked binary image file with null bytes
        f4 = repo_dir / "image.png"
        f4.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 1000)

        # 6. Add large untracked text file (>500KB)
        f5 = repo_dir / "large_text.log"
        f5.write_text("log line\n" * 80_000)

        # Run rpc_git_diff_numstat and measure time
        handler = JsonRpcHandler()
        t0 = time.perf_counter()
        res = await handler.rpc_git_diff_numstat({"project_path": str(repo_dir)})
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert "files" in res
        files = res["files"]
        assert "tracked.txt" in files
        assert "untracked.py" in files
        assert "large_model.safetensors" in files
        assert "image.png" in files
        assert "large_text.log" in files

        # Check that binary file additions are 0
        assert files["image.png"]["additions"] == 0
        assert files["large_model.safetensors"]["additions"] == 0
        # Check that large text file additions are capped at 1
        assert files["large_text.log"]["additions"] == 1
        # Check that untracked text file has ~500 additions
        assert files["untracked.py"]["additions"] == 500

        # Performance assertion: must complete in under 500ms (accounting for Windows git.exe process launches)
        assert elapsed_ms < 500.0, f"diff_numstat took {elapsed_ms:.2f}ms, expected < 500ms"

@pytest.mark.asyncio
async def test_revert_file_tracked_and_untracked():
    with tempfile.TemporaryDirectory() as tmpdir:
        repo_dir = Path(tmpdir)
        repo = git.Repo.init(repo_dir)

        # Initial commit
        tracked = repo_dir / "file.txt"
        tracked.write_text("original content")
        repo.git.add("file.txt")
        repo.git.commit("-m", "initial")

        # Modify tracked
        tracked.write_text("modified content")
        assert tracked.read_text() == "modified content"

        # Create untracked
        untracked = repo_dir / "new_file.txt"
        untracked.write_text("brand new")
        assert untracked.exists()

        handler = JsonRpcHandler()

        # Revert tracked
        res_tracked = await handler.rpc_git_revert_file({
            "project_path": str(repo_dir),
            "path": "file.txt"
        })
        assert res_tracked["success"] is True
        assert res_tracked["action"] == "checkout"
        assert tracked.read_text() == "original content"

        # Revert untracked
        res_untracked = await handler.rpc_git_revert_file({
            "project_path": str(repo_dir),
            "path": "new_file.txt"
        })
        assert res_untracked["success"] is True
        assert res_untracked["action"] == "deleted"
        assert not untracked.exists()
