pipeline {
    agent any

    environment {
        NODE_ENV = "production"
        PM2_APP_NAME = "trlreply-bot"
    }

    stages {
        stage('Install, Lint & Format (Parallel)') {
            parallel {
                stage('Install Dependencies') {
                    steps {
                        sh 'npm ci'        // faster and reproducible
                    }
                }
                stage('Lint') {
                    steps {
                        sh 'npm run lint --if-present'
                    }
                }
                stage('Prettier Format') {
                    steps {
                        sh 'npm run format --if-present'
                    }
                }
            }
        }

        stage('Build') {
            steps {
                sh 'npm run build --if-present'
            }
        }

        stage('Deploy with PM2') {
            steps {
                // Stop old app if exists
                sh '''
                    pm2 describe $PM2_APP_NAME > /dev/null 2>&1
                    if [ $? -eq 0 ]; then
                      pm2 delete $PM2_APP_NAME
                    fi
                '''

                // Start fresh build
                sh '''
                    pm2 start dist/index.js --name $PM2_APP_NAME
                    pm2 save
                '''
            }
        }
    }
    post {
        always {
            script {
                echo '🧹 Cleaning up workspace...'
                cleanWs()
            }
            // Add notification steps here (Email, Slack, etc.) later
        }
        success {
            script {
                echo '✅ Build successful!'
            }
        }
        failure {
            script {
                echo '❌ Build failed!'
            }
        }
    }
}
