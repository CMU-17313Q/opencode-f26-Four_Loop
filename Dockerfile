FROM oven/bun:1.3.14

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      ca-certificates \
      curl \
      python3 \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY . .

RUN bun install --frozen-lockfile

# Build the local frontend and embed it in the OpenCode executable.
# Explicit channel/version values allow builds without the .git directory.
RUN OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.18.15 \
    bun run --cwd packages/opencode build --single --skip-install && \
    cp packages/opencode/dist/opencode-linux-*/bin/opencode /usr/local/bin/opencode

EXPOSE 4096

CMD ["/usr/local/bin/opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
