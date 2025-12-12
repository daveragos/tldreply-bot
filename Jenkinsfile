/**
 * FINAL Declarative Pipeline - Uses 'tools' for Node version and 'npx' for reliable local execution.
 */
pipeline {
    agent any 

    tools {
        // Keeps Node.js 20 installed and available (Fixes Node version warnings)
        nodejs 'node22' 
    }

    environment {
        // FIX: REMOVED the problematic PATH update.
        PM2_APP_NAME = "trlreply-bot"
        // Load secrets from Jenkins credentials
        TELEGRAM_TOKEN = credentials('telegram-token')
        DATABASE_URL = credentials('database-url')
        ENCRYPTION_SECRET = credentials('encryption-secret')
    }

    stages {
        stage('📦 Install Dependencies') {
            steps {
                echo '⬇️ Installing dependencies...'
                sh 'npm ci' 
            }
        }

        // Stage 2: Code Quality Checks (FIXED with npx)
        stage('🧪 Lint, Format, & Test (Parallel)') {
            parallel {
                stage('Lint Check') { 
                    steps { 
                        echo '🧹 Running ESLint...'; 
                        // CRITICAL FIX: Run via npm run to use local binaries
                        sh 'npm run lint' 
                    }
                }
                stage('Format Check') { 
                    steps { 
                        echo '✨ Running Prettier...'; 
                        // CRITICAL FIX: Run via npm run to use local binaries
                        sh 'npm run format:check' 
                    } 
                }
            }
        }

        // Stage 3: Build Application (FIXED with npx)
        stage('🔨 Build Application') {
            steps {
                echo '🛠️ Compiling TypeScript...'
                // CRITICAL FIX: Run via npm run to use local binaries
                sh 'npm run build'
            }
        }

        // Stage 4: Deploy Application (PM2 is typically globally installed, so no npx needed)
        stage('🚀 Deploy with PM2') {
            steps {
                echo "☁️ Deploying application: ${env.PM2_APP_NAME}"
                
                sh '''
                    if pm2 describe $PM2_APP_NAME > /dev/null 2>&1; then
                        echo "App $PM2_APP_NAME is running. Deleting..."
                        pm2 delete $PM2_APP_NAME
                    else
                        echo "App $PM2_APP_NAME is not running."
                    fi
                '''
                // Ensure production env for runtime and pass secrets
                sh "NODE_ENV=production TELEGRAM_TOKEN=$TELEGRAM_TOKEN DATABASE_URL=$DATABASE_URL ENCRYPTION_SECRET=$ENCRYPTION_SECRET pm2 start dist/index.js --name $PM2_APP_NAME"
                sh 'pm2 save'
                sh 'pm2 list'
            }
        }
    }

    post {
        always {
            echo '🧹 Cleaning up workspace...'
            cleanWs() 
        }
        success {
            echo '🎉 SUCCESS! Pipeline completed successfully!'
        }
        failure {
            echo '❌ FAILED! Check the logs for errors.'
        }
    }
}