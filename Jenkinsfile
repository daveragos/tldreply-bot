/**
 * FINAL Declarative Pipeline for tldreply-bot CI/CD.
 * Uses the 'node' wrapper with label 'node20' to enforce Node.js 20.x
 * (required by project dependencies) and resolve all PATH issues.
 */
pipeline {
    // Agent: The initial phase runs on 'any' to read the Jenkinsfile.
    agent any

    environment {
        // Only set application-specific variables. The 'node' wrapper handles the PATH for us.
        NODE_ENV = "production"
        PM2_APP_NAME = "trlreply-bot"
    }

    stages {
        // Stage 1: Dependency Installation (All stages now run inside the 'node20' environment)
        stage('📦 Install Dependencies') {
            steps {
                // The 'node' step schedules the task on an agent configured with the 'node20' tool.
                node('node20') { 
                    echo '⬇️ Installing dependencies...'
                    sh 'npm ci' 
                }
            }
        }

        // Stage 2: Code Quality Checks
        stage('🧪 Lint, Format, & Test (Parallel)') {
            node('node20') { 
                parallel {
                    // We use 'npm run ...' because 'npx' is now redundant since the 'node' block sets the PATH.
                    stage('Lint Check') { steps { echo '🧹 Running ESLint...'; sh 'npm run lint' } }
                    stage('Format Check') { steps { echo '✨ Running Prettier...'; sh 'npm run format:check' } }
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
                    
                    // The PM2 commands rely on PM2 being globally installed or in the PATH.
                    // This assumes PM2 is globally available on the agent OR you install it here.
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