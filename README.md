# tryEnv - ReadMe

This is ReadMe for tryEnv - a VS Code extension that lets you securely store, manage, and sync your environment variables with ease. With TryEnv, you can back up your variables directly to your GitHub account in an encrypted format, ensuring they’re always safe and accessible when you need them.


## Features

- Secure Backup & Sync: Safely back up your environment variables to your GitHub account using robust encryption.

- Easy Access & Restore: Restore variables with a simple sync after any reset, keeping them ready for every project.

- Environment Management: Organize variables for different environments (Preview, Development, Production) in dedicated files.

- User Privacy: No sensitive data is stored outside your GitHub; only you have access to your encryption keys.


## Installation

1. [Install](https://cli.github.com/) & [configure](https://cli.github.com/manual/gh_auth_login) GitHub CLI if it’s not already set up on your system.

_Note: You can simply install it and run it locally too if you don't want to configure Github CLI._

2. Add [tryEnv](https://www.tryenv.xyz/): Open the Extensions view in VS Code, search for tryEnv, and install it.


## Getting Started

1. Configure GitHub CLI: Authenticate GitHub CLI .

![Image01](/public/Image01.jpeg)


2. Create a New Project: With tryEnv installed, create a new project, and a tryEnv folder will be automatically generated with three files:

   - Preview Variables
   - Development Variables
   - Production Variables
   
   ![Image02](/public/Image02.jpeg)


3. Add Environment Variables: Enter your environment variables in the respective files. tryEnv automatically encrypts and stores them securely.

![Image03](/public/Image03.jpeg)

## Backup & Sync

To restore variables after a VS Code reset or on a new device:

1. Install tryEnv and ensure GitHub CLI is configured.

2. Click Sync in tryEnv to fetch your backup from GitHub, restoring your variables into their respective files (Preview, Development, Production).


## Security

tryEnv uses AES-256-GCM encryption with SHA-512 hashing to secure your data. All variables are encrypted and stored in a json within tryEnv-Backup repository in your GitHub account. Only you can access and decrypt this data—no keys are stored externally.

## Release Notes
Version 1.0.0 – Initial release of tryEnv!

  Secure environment variable     
  management with separate files for    
  Preview, Development, and Production.

  Encrypted GitHub backup with easy 
  sync and restore.

  Requires GitHub CLI setup. 

 
## Support

For any questions or issues, feel free to contact our support team or raise an issue on our GitHub repository