FROM node:20-alpine
WORKDIR /app
COPY apps/static-web/index.html .
COPY apps/static-web/server.js .
EXPOSE 80
CMD ["node", "server.js"]
