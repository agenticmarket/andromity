import sys


def check_runtime() -> None:
    """Verify provider dependencies in a frozen release without network calls."""
    import litellm
    from litellm.proxy.spend_tracking.savings import (
        extract_cache_creation_tokens,
        extract_cache_read_tokens,
    )

    assert callable(litellm.acompletion)
    assert callable(extract_cache_creation_tokens)
    assert callable(extract_cache_read_tokens)
    print("Andromity provider runtime OK")

if __name__ == "__main__":
    if sys.argv[1:] == ["--check-runtime"]:
        check_runtime()
    else:
        from andromity.server.main import main

        main()
