const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

function readSecret(secretName, envFallback) {
    if (envFallback && process.env[envFallback]) return process.env[envFallback];
    try {
        return fs.readFileSync(`/run/secrets/${secretName}`, 'utf8').trim();
    } catch {
        return '';
    }
}

async function main() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET_NAME;
    const accessKeyId = readSecret('r2_access_key_id', 'R2_ACCESS_KEY_ID');
    const secretAccessKey = readSecret('r2_secret_access_key', 'R2_SECRET_ACCESS_KEY');

    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
        console.error('Missing credentials or config', { accountId, bucket, hasAccess: !!accessKeyId, hasSecret: !!secretAccessKey });
        process.exit(1);
    }

    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey }
    });

    const corsCommand = new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
            CORSRules: [
                {
                    AllowedHeaders: ['*'],
                    AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
                    AllowedOrigins: ['*'],
                    ExposeHeaders: ['ETag']
                }
            ]
        }
    });

    try {
        await client.send(corsCommand);
        console.log('Successfully set CORS rules for bucket:', bucket);
    } catch (err) {
        console.error('Error setting CORS rules:', err);
        process.exit(1);
    }
}

main();