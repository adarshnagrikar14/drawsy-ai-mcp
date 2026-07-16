FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY dist ./dist
EXPOSE 3031
CMD ["npm", "start"]
