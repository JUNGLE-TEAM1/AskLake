FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_BASE_URL
ARG VITE_AUTH_PUBLIC_SIGNUP=false
ARG VITE_USE_MOCK_API=false
ARG VITE_DASHBOARD_ASSISTANT_API_PATH

ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_AUTH_PUBLIC_SIGNUP=${VITE_AUTH_PUBLIC_SIGNUP}
ENV VITE_USE_MOCK_API=${VITE_USE_MOCK_API}
ENV VITE_DASHBOARD_ASSISTANT_API_PATH=${VITE_DASHBOARD_ASSISTANT_API_PATH}

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
