FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY relay.js ./

# Set environment defaults
ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

CMD ["node", "relay.js"]
