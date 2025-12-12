/**
 * FINAL Declarative Pipeline - Uses 'tools' for Node version and 'npx' for reliable local execution.
 */
pipeline {
    agent any 

    tools {
        // Keeps Node.js 20 installed and available (Fixes Node version warnings)
        nodejs 'node20' 
    }

    environment {
        // FIX: REMOVED the problematic PATH update.
        NODE_ENV = "production"
        PM2_APP_NAME = "trlreply-bot"
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
                        // CRITICAL FIX: Use npx to find the local executable
                        sh 'npx npm run lint' 
                    }
                }
                stage('Format Check') { 
                    steps { 
                        echo '✨ Running Prettier...'; 
                        // CRITICAL FIX: Use npx to find the local executable
                        sh 'npx npm run format:check' 
                    } 
                }
            }
        }

        // Stage 3: Build Application (FIXED with npx)
        stage('🔨 Build Application') {
            steps {
                echo '🛠️ Compiling TypeScript...'
                // CRITICAL FIX: Use npx to find the local executable
                sh 'npx npm run build'
            }
        }

        // Stage 4: Deploy Application (PM2 is typically globally installed, so no npx needed)
        stage('🚀 Deploy with PM2') {
            steps {
                echo "☁️ Deploying application: ${env.PM2_APP_NAME}"
                
                sh '''
                    pm2 describe $PM2_APP_NAME > /dev/null 2>&1
                    if [ $? -eq 0 ]; then pm2 delete $PM2_APP_NAME; fi
                '''
                sh "pm2 start dist/index.js --name $PM2_APP_NAME"
                sh 'pm2 save'
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