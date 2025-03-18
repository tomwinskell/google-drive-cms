import fs from 'fs';
import axios from 'axios';
import { google } from 'googleapis';
import path from 'path';

// If modifying these scopes, delete token.json.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
];

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_ROOT = 'secret/';
const TOKEN_PATH = TOKEN_ROOT + 'token.json';
const CACHE_ROOT = 'cache/';
const CACHE_PATH = CACHE_ROOT + 'cache.json';
const CREDENTIALS_PATH = 'secret/credentials.json';
// const TEAM_DRIVE_ID = '0AKS-uLyEVtEdUk9PVA';

export default class DriveAPI {
  constructor() {
    this.auth = null;
    this.drive = null;
    this.sheets = null;
    this.cache = {};

    /**
     * The base API url for this service, used for <img src=""> in cached images
     * Can (and should) be modified by client application for production deployment URL
     */
    this.restEndpoint = 'https://google-drive-cms.herokuapp.com/api/v1/';
    // this.restEndpoint = 'http://localhost/api/v1';

      // Load client secrets from file (recommended default)
      console.log(
        'Using secret/credentials.json for CLIENT_EMAIL and PRIVATE_KEY'
      );
      fs.readFile(CREDENTIALS_PATH, (err, content) => {
        if (err) return this.missingCredentials();
        // Authorize a client with credentials, then call the Google Drive API.
        this.authorize(
          JSON.parse(content.toString()),
          this.authCallback.bind(this)
        );
      });

    this.readCache();
  }

  missingCredentials() {
    console.error(`Could not load ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  authCallback(auth) {
    console.log('Google authorization succeeded');
    this.auth = auth;
    this.drive = google.drive({ version: 'v3', auth });
    this.sheets = google.sheets({ version: 'v4', auth });
    // this.drive.files.list().then((res) => console.log('files: ', res.data));
  }

  authorize(credentials, callback) {
    const { client_email, private_key } = credentials;

    const jwtClient = new google.auth.JWT(
      client_email,
      null,
      private_key,
      SCOPES
    );

    // Check if we have previously stored a token.
    fs.readFile(TOKEN_PATH, (err, token) => {
      if (err) return this.getAccessToken(jwtClient, callback);
      jwtClient.setCredentials(JSON.parse(token.toString()));
      console.log('Token loaded from file');
      callback(jwtClient);
    });
  }

  getAccessToken(jwtClient, callback) {
    jwtClient.authorize((err, tokens) => {
      if (err) return console.log(err);
      else {
        if (!fs.existsSync(TOKEN_ROOT)) fs.mkdirSync(TOKEN_ROOT);
        fs.writeFile(TOKEN_PATH, JSON.stringify(tokens), (err) => {
          if (err) return console.error(err);
          console.log('Token stored to', TOKEN_PATH);
        });
        callback(jwtClient);
      }
    });
  }

  readCache() {
    fs.readFile(CACHE_PATH, (err, cache) => {
      if (err) {
        fs.mkdirSync(CACHE_ROOT);
        return console.log('No cache found');
      }
      this.cache = JSON.parse(cache.toString());
      console.log('Cache loaded from file');
    });
  }

  writeCache() {
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(this.cache));
      console.log('Cache stored to', CACHE_PATH);
    } catch (error) {
      console.error('Failed to write cache', error);
    }
  }

  getSheet(id, range) {
    return new Promise((resolve, reject) => {
      this.sheets.spreadsheets.values.get(
        {
          spreadsheetId: id,
          range: range,
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          console.log(res.data.values);
          const keys = res.data.values[0];
          const transformed = [];
          res.data.values.forEach((row, i) => {
            if (i === 0) return;
            const item = {};
            row.forEach((cell, index) => {
              item[keys[index]] = cell;
            });
            transformed.push(item);
          });
          resolve(transformed);
        }
      );
    });
  }

  getCache(...params) {
    const hash = params.join('');
    return this.cache[hash];
  }

  setCache(hash, version, json) {
    json.version = version;
    return (this.cache[hash] = json);
  }

  getDoc(id) {
    return new Promise((resolve, reject) => {
      this.drive.files.export(
        {
          fileId: id,
          mimeType: 'text/html',
          fields: 'data',
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          resolve({ html: this.rewriteToCachedImages(res.data) });

          // Cache images
          this.cacheImages(res.data);
        }
      );
    });
  }

  cacheImages(html) {
    const URL_REGEX =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{2,255}\.googleusercontent\.com(?:\/[-a-zA-Z0-9@:%_+.~#?&//=]*)?/g;

    const images = html.match(URL_REGEX);
    if (!images || images.length <= 0) {
      return;
    }
    images.forEach((image) => this.downloadImage(image));
  }

  rewriteToCachedImages(html) {
    const IMG_REGEX =
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{2,255}\.googleusercontent\.com\b\/([-a-zA-Z0-9@:%_+.~#?&//=]*)/g;
    return html.replace(IMG_REGEX, this.restEndpoint + '/getImage?id=$2');
  }
  
  async downloadImage(url) {
    const split = url.split('/');
    const cache_filename = path.join(CACHE_ROOT, split[split.length - 1]);
  
    // Check if the file already exists in the cache
    if (fs.existsSync(cache_filename)) return;
  
    try {
      // Perform a HEAD request to check the image
      const headResponse = await axios.head(url);
      
      if (headResponse.status === 200) {
        // Now perform the GET request to download the image
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream', // Set the response type to stream to pipe it directly to a file
        });
  
        // Pipe the image data into the cache file
        const writer = fs.createWriteStream(cache_filename);
        response.data.pipe(writer);
  
        writer.on('finish', () => {
          console.log('Cached image to', cache_filename);
        });
  
        writer.on('error', (err) => {
          console.error('Error downloading', cache_filename, err);
        });
      } else {
        console.error('Error: Unable to fetch the image', url);
      }
    } catch (err) {
      console.error('Error downloading the image', cache_filename, err);
    }
  }
  

  listFiles(folderId, teamDriveId = undefined) {
    return new Promise((resolve, reject) => {
      this.drive.files.list(
        {
          orderBy: 'name',
          pageSize: 20,
          q: `'${folderId}' in parents and trashed != true`,
          corpora: teamDriveId ? 'teamDrive' : undefined,
          includeTeamDriveItems: !!teamDriveId,
          supportsTeamDrives: !!teamDriveId,
          teamDriveId,
          fields: 'files(id, name, version)',
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          resolve(res.data.files);
        }
      );
    });
  }

  getVersion(fileId) {
    return new Promise((resolve, reject) => {
      this.drive.files.get(
        {
          fileId,
          supportsTeamDrives: true,
          fields: 'version',
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          // console.log("version check for",fileId,"returned",res.data.version);
          resolve(parseInt(res.data.version));
        }
      );
    });
  }

  getSheetList(spreadsheetId) {
    return new Promise((resolve, reject) => {
      this.sheets.spreadsheets.get(
        {
          spreadsheetId,
          fields: 'sheets(properties(title))',
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          resolve(res.data.sheets.map((obj) => obj.properties.title));
        }
      );
    });
  }

  transformSheetJson(values) {
    const keys = values[0];
    const transformed = [];
    values.forEach((row, i) => {
      if (i === 0) return;
      const item = {};
      row.forEach((cell, index) => {
        item[keys[index]] = cell;
      });
      transformed.push(item);
    });
    return transformed;
  }

  batchGetSheet(spreadsheetId) {
    return this.getSheetList(spreadsheetId).then(
      (sheets) =>
        new Promise((resolve, reject) => {
          this.sheets.spreadsheets.values.batchGet(
            {
              spreadsheetId,
              ranges: sheets,
            },
            (err, res) => {
              if (err) return reject('The API returned an error: ' + err);
              // console.log(res.data.values);
              const output = {};
              res.data.valueRanges.forEach((valueRange) => {
                const sheetName = valueRange.range.split('!')[0];
                output[sheetName] = this.transformSheetJson(valueRange.values);
              });
              resolve(output);
            }
          );
        })
    );
  }

  getResource(file, files) {
    switch (file.mimeType) {
      case 'application/vnd.google-apps.spreadsheet':
        return this.batchGetSheet(file.id);
      case 'application/vnd.google-apps.document':
        return this.getDoc(file.id);
      case 'application/vnd.google-apps.folder':
        return Promise.resolve(
          files.filter((f) => f.parents && f.parents.includes(file.id))
        );
      default:
        return Promise.reject(`Unknown file mime type: ${file.mimeType}`);
    }
  }

  listAllFiles(teamDriveId = undefined) {
    return new Promise((resolve, reject) => {
      this.drive.files.list(
        {
          orderBy: 'name',
          pageSize: 100,
          q: `trashed != true`,
          corpora: teamDriveId ? 'teamDrive' : undefined,
          includeTeamDriveItems: !!teamDriveId,
          supportsTeamDrives: !!teamDriveId,
          teamDriveId,
          fields: 'files(id, name, version, mimeType, parents)',
        },
        (err, res) => {
          if (err) return reject('The API returned an error: ' + err);
          resolve(res.data.files);
        }
      );
    });
  }

  getCachePromise(file, files) {
    const version = parseInt(file.version);
    console.log('Pulling latest version for', file.name);
    return this.getResource(file, files)
      .then((resource) => {
        resource.version = version;
        return (this.cache[file.id] = resource);
      })
      .catch((error) => {
        console.error('Pull failed for', file.name);
        console.error(error);
        return this.cache[file.id];
      });
  }

  getAll(teamDriveId = undefined) {
    return (
      this.listAllFiles(teamDriveId)
        // @ts-ignore
        .then((files) => {
          const too_old = files.filter(
            (file) =>
              !this.cache[file.id] ||
              this.cache[file.id].version < parseInt(file.version)
          );

          // Don't overload the API; do these in series if there are a lot
          if (too_old.length > 4) {
            console.log(
              'Fetching',
              too_old.length,
              'resources; throttling sequentially'
            );
            let promise = Promise.resolve();
            too_old.forEach(
              (file) =>
                (promise = promise.then(() =>
                  this.getCachePromise(file, files)
                ))
            );
            return promise;
          }

          // In most cases we can run them in parallel and get faster results
          else {
            return Promise.all(
              too_old.map((file) => this.getCachePromise(file, files))
            );
          }
        })
        .then(() => this.cache)
    );
  }
}
