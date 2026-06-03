# Use official Node.js LTS image
FROM node:20-slim AS base

# Install build essentials for better-sqlite3 (native modules)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/

# Install dependencies
RUN cd backend && npm install --production

# Copy the rest of the application
COPY backend ./backend
COPY frontend ./frontend
COPY data ./data

# Expose the port
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/fsa_parser.db

# Command to run the application
CMD ["node", "backend/server.js"]
