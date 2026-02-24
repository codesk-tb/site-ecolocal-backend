# Common build stage
FROM node:22

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV production
ENV PORT=3000
ENV NODE_ENV=development

ENV DB_HOST=51.77.134.195
ENV DB_PORT=3306
ENV DB_USER=ecolocal
ENV DB_PASSWORD=ecolocal1234
ENV DB_NAME=ecolocal

ENV JWT_SECRET=EcolocalSecretKeyJWT
ENV JWT_EXPIRES_IN=7d
ENV ENCRYPTION_KEY=Ecolocalsecretkey
ENV FRONTEND_URL=https://ecolocal.codesk.fr

ENV UPLOAD_DIR=./uploads
ENV MAX_FILE_SIZE=5242880
EXPOSE 3000
CMD ["npm", "run", "start"]
