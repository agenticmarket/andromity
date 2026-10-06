# syntax=docker/dockerfile:1.4
# ==============================================================================
# Andromity — Autonomous AI Coding Agent (Multi-Stage Production Dockerfile)
# Repository: https://github.com/agenticmarket/andromity
# License: MIT
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build & Dependency Resolution (Fast compilation via Astral uv)
# ------------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Copy uv binary for rapid dependency resolution
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /bin/uv

# Install system build dependencies required for native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create isolated Python virtual environment
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /build

# Copy project manifest and source code
COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/

# Install Andromity and production dependencies into /opt/venv
RUN UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --locked --no-dev --no-editable --no-cache

# ------------------------------------------------------------------------------
# Stage 2: Hardened Runtime Container
# ------------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="Andromity" \
      org.opencontainers.image.description="Autonomous AI Coding Agent with TUI, live execution waterfall, and trust governance." \
      org.opencontainers.image.url="https://andromity.agenticmarket.dev" \
      org.opencontainers.image.source="https://github.com/agenticmarket/andromity" \
      org.opencontainers.image.vendor="AgenticMarket" \
      org.opencontainers.image.licenses="MIT"

# Install essential runtime tools:
# - git: Required for git tracking, diff generation, and repository exploration
# - curl & ca-certificates: Required for secure SSL communication with LLM edge APIs
# - tini: Lightweight init process for POSIX signal handling and reaping child processes
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder stage
COPY --from=builder /opt/venv /opt/venv

# Copy entrypoint initialization script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# Environment configuration
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    ANDROMITY_CLIENT=docker

# Create unprivileged application user & group (UID 1000, GID 1000)
RUN groupadd -g 1000 andromity && \
    useradd -u 1000 -g andromity -m -s /bin/bash andromity

# Prepare workspace and persistent configuration directories
RUN mkdir -p /workspace /home/andromity/.andromity && \
    chown -R andromity:andromity /workspace /home/andromity

USER andromity
WORKDIR /workspace

# Declare volumes for user code and persistent session/credential state
VOLUME ["/workspace", "/home/andromity/.andromity"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD []
