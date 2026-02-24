node {
    if (BRANCH_NAME == "main") {
    def app
    stage('Clone repository') {checkout scm}
    stage('Build image fro aneti') { app = docker.build("ecolocal-back-preprod", "-f Dockerfile .")}
    stage('Push image back aneti  to registry') {
    docker.withRegistry('https://registryovh2.jtsolution.org', 'registory_login') 
    {
    app.push("${env.BUILD_NUMBER}")
    app.push("latest")
    }
    }
}
}
// sudo docker stack deploy  --with-registry-auth  --compose-file /home/ubuntu/projects-v1/preprod/ecolocal/back/docker-compose.yml preprod