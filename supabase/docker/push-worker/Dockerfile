# Tiny push-worker: node + the pg driver, nothing else.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
CMD ["node", "index.mjs"]
