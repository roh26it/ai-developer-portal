FROM oven/bun:1.4-alpine AS build
WORKDIR /src
COPY package.json server.js ./
COPY public ./public
RUN bun build server.js --compile --minify --outfile /portal

FROM alpine:3.22
# The compiled Bun runtime links against these on musl.
RUN apk add --no-cache libstdc++ libgcc
COPY --from=build /portal /usr/local/bin/portal
ENV NODE_ENV=production
USER nobody
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["portal"]
