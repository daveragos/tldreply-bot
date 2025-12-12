/**
 * FINAL Declarative Pipeline for tldreply-bot CI/CD.
 * Uses the 'node' wrapper with label 'node20' and has correct syntax for parallel steps.
 */
pipeline {
    agent any

    environment {
        NODE_ENV = "production"
        PM2_APP_NAME = "trlreply-bot"
    }

    stages {
        // Stage 1: Dependency Installation
        stage('📦 Install Dependencies') {
            steps {
                node('node20') { 
                    echo '⬇️ Installing dependencies...'
                    sh 'npm ci' 
                }
            }
        }

        // Stage 2: Code Quality Checks (Corrected Parallel Syntax)
        stage('🧪 Lint, Format (Parallel)') {
            steps {
                node('node20') { 
                    // Use the parallel step with named blocks for concurrency
                    parallel(
                        'Lint Check': { 
                            echo '🧹 Running ESLint...'; 
                            sh 'npm run lint' 
                        },
                        'Format Check': { 
                            echo '✨ Running Prettier...'; 
                            sh 'npm run format:check' 
                        },                      
                    )
                }
            }
        }

        // Stage 3: Build Application
        stage('🔨 Build Application') {
            steps {
                node('node20') { 
                    echo '🛠️ Compiling TypeScript...'
                    sh 'npm run build'
                }
            }
        }

        // Stage 4: Deploy Application
        stage('🚀 Deploy with PM2') {
            steps {
                node('node20') { 
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