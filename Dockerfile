FROM nginx:1.27-alpine

# Serve the app as static content
COPY . /usr/share/nginx/html
