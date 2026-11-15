FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data BIND_HOST=0.0.0.0 PORT=8099
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && install -d -o node -g node -m 0700 /app/data
COPY server.mjs database.mjs LICENSE THIRD_PARTY_NOTICES.txt ./
COPY public/ ./public/
USER node
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["node","-e","fetch('http://127.0.0.1:8099/healthz').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)"]
CMD ["node","server.mjs"]
