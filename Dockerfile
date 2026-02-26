FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p data

EXPOSE 5555

CMD ["bun", "run", "src/server.ts"]
