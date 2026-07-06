# Custom Caddy with the rate-limit module (not in the stock image).
# Pinned builder + runtime; bump deliberately.
FROM caddy:2.8.4-builder AS builder

RUN xcaddy build v2.8.4 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.8.4

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
