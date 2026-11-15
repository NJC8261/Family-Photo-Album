FROM node:22-alpine
# poppler-utils renders PDF pages into images for the swipe viewer; fonts help with PDFs that don't embed theirs
RUN apk add --no-cache poppler-utils ttf-dejavu
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
