pipeline {
  agent any
  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Pull from GitHub on VPS') {
      steps {
        script {
          sh """
          cd ${PROJECT_DIR} || { echo "Directory ${PROJECT_DIR} does not exist!"; exit 1; }
          git pull origin main
          """
        }

      }
    }

    stage('Install Dependencies') {
      steps {
        script {
          sh """
          cd ${PROJECT_DIR}
          npm install
          """
        }

      }
    }

    stage('Lint and Format') {
      parallel {
        stage('Format Check') {
          steps {
            script {
              sh """
              cd ${PROJECT_DIR}
              npm run format
              """
            }

          }
        }

        stage('Lint') {
          steps {
            script {
              sh """
              cd ${PROJECT_DIR}
              npm run lint
              """
            }

          }
        }

      }
    }

    stage('Build') {
      steps {
        script {
          sh """
          cd ${PROJECT_DIR}
          npm run build
          """
        }

      }
    }

    stage('Deploy with PM2') {
      steps {
        script {
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
  environment {
    PROJECT_DIR = '/var/www/tldreply'
  }
  post {
    success {
      echo 'Pipeline completed successfully!'
    }

    failure {
      echo 'Pipeline failed!'
    }

    always {
      cleanWs()
    }

  }
  triggers {
    pollSCM('H/5 * * * *')
  }
}