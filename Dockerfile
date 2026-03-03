FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY public ./public
COPY data ./data
COPY scripts ./scripts
COPY README.md ./README.md

EXPOSE 4300
CMD ["node", "server.js"]
