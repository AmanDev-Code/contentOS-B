FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache fontconfig ttf-dejavu && fc-cache -f

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
