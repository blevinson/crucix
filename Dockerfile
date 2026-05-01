FROM node:22-alpine

WORKDIR /app

# Claude Code CLI is required by ClaudeCodeProvider — spawned per LLM call,
# reads OAuth from $HOME/.claude/.credentials.json (PVC-mounted).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Default port (override with -e PORT=xxxx)
EXPOSE 3117

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3117/api/health || exit 1

CMD ["node", "server.mjs"]
