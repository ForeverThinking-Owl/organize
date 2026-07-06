FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/

CMD ["npx", "tsx", "src/examples/customer-after-sales.demo.ts"]
