pipeline {
    agent any

    environment {
        CI = 'true'
        PROJECT_DIR = '/var/www/tldreply-bot'
    }

    tools {
        // Install the NodeJS version configured in the Jenkins Global Tool configuration
        // Make sure Node.js is configured in: Manage Jenkins -> Global Tool Configuration
        nodejs 'nodejs'
    }

    options {
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        disableConcurrentBuilds()
        timeout(time: 15, unit: 'MINUTES')
    }

    stages {
        // Stage 1: Clean Workspace
        stage('1. Clean Workspace') {
            steps {
                script {
                    echo '🧹 Cleaning workspace...'
                    cleanWs()
                }
            }
        }

        // Stage 2: Checkout
        stage('2. Checkout') {
            steps {
                script {
                    echo '⬇️ Checking out source code...'
                    checkout scm
                }
            }
        }

        

        // Stage 4: Install Dependencies
        stage('3. Install Dependencies') {
            steps {
                script {
                    echo '📦 Installing dependencies...'
                    sh """
                        cd ${PROJECT_DIR}
                        npm install
                    """
                }
            }
        }

        // Stage 5: Code Quality Checks
        stage('4. Code Quality') {
            parallel {
                stage('Format Check') {
                    steps {
                        script {
                            echo '💅 Checking code formatting...'
                            sh """
                                cd ${PROJECT_DIR}
                                npm run format:check
                            """
                        }
                    }
                }
                stage('Lint') {
                    steps {
                        script {
                            echo '🔍 Linting code...'
                            sh """
                                cd ${PROJECT_DIR}
                                npm run lint:fix
                            """
                        }
                    }
                }
            }
        }

        // Stage 6: Build Application
        stage('5. Build') {
            steps {
                script {
                    echo '🏗️ Building application...'
                    sh """
                        cd ${PROJECT_DIR}
                        npm run build
                    """
                }
            }
        }

        // Stage 7: Deploy with PM2
        stage('6. Deploy') {
            steps {
                script {
                    echo '🚀 Deploying application with PM2...'
                    sh """
                        cd ${PROJECT_DIR}
                        # Delete old PM2 instance if it exists (ignore error if it doesn't)
                        pm2 delete tldreply || true
                        
                        # Start new instance
                        pm2 start dist/index.js --name tldreply
                        
                        # Configure PM2 to start on system boot
                        # Try to set up startup script (may require sudo - configure passwordless sudo for Jenkins user)
                        pm2 startup systemd | tail -n 1 | bash || echo "PM2 startup may already be configured or requires manual sudo setup"
                        
                        # Save PM2 process list (required for auto-start)
                        pm2 save
                    """
                }
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
