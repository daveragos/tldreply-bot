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
        // Must match the name in ecosystem.config.js.
        PM2_APP_NAME = "tldreply-bot"
        // Previous deployments ran under a misspelled name; removed on deploy so
        // two instances never poll Telegram at the same time.
        PM2_LEGACY_APP_NAME = "trlreply-bot"
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
                stage('Unit Tests') {
                    steps {
                        echo '🧪 Running tests...';
                        sh 'npm test'
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
                echo "☁️ Deploying from new"

                sh '''
                    for app in $PM2_APP_NAME $PM2_LEGACY_APP_NAME; do
                        if pm2 describe "$app" > /dev/null 2>&1; then
                            echo "App $app is running. Deleting..."
                            pm2 delete "$app"
                        else
                            echo "App $app is not running."
                        fi
                    done
                '''
                // Start via ecosystem.config.js so max_memory_restart and the log
                // paths defined there actually apply. Secrets stay in the env.
                sh "NODE_ENV=production TELEGRAM_TOKEN=$TELEGRAM_TOKEN DATABASE_URL=$DATABASE_URL ENCRYPTION_SECRET=$ENCRYPTION_SECRET pm2 start ecosystem.config.js --env production"
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