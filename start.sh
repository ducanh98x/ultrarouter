docker stop ultrarouter
docker rm ultrarouter
docker build -t ultrarouter .
docker run -d --name ultrarouter -p 20128:20128 --env-file .env -v ultrarouter-data:/app/data ultrarouter