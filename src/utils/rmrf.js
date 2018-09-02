const { promisify } = require('util');
const { rmdir, chmod, readdir, unlink, lstat } = require('fs');

const rmdirp = promisify(rmdir);
const chmodp = promisify(chmod);
const readdirp = promisify(readdir);
const unlinkp = promisify(unlink);
const lstatp = promisify(lstat);

/**
 * Determines if a file system entry exists, and if it does, what it is.
 * @param {string} p the path to the file system entry to check.
 * @returns {string|boolean} false if it doesn't exist, 'directory', 'file' or
 * 'other' otherwise.
 */
const fileExists = async(p) => {
    try {
        const stat = await lstatp(p);
        if (stat.isDirectory()) {
            return 'directory';
        }
        if (stat.isFile()) {
            return 'file';
        }
        return 'other';
    }
    catch (e) {
        return false;
    }
};

/**
 * Lists all the file system entries in a directory.
 * @param {string} directory directory to list the file system entries of.
 * @return {Array<string>} the file system entries in the directory. If the directory
 * does not exist or there is a problem listing its contents, this will be an empty
 * array.
 */
const filesInDirectory = async(directory) => {
    try {
        const files = await readdirp(directory);
        return !files ? [] : files;
    }
    catch (e) {
        return [];
    }
};

/**
 * Delete a directory. Unlike fs.rmdir which will not delete a directory with
 * content, this method will delete a directory regardless of contents. Does not
 * follow symlinks.
 * @param {string} directory the (potentially non-empty) directory to delete.
 * @param {function()} callback method called on success or failure, (error).
 */
const deleteDirectory = async(directory) => {
    await Promise.all((await filesInDirectory(directory)).map(async(file) => {
        file = path.join(directory, file);
        try {
            if (await fileExists(file) === 'directory') {
                await deleteDirectory(file);
            }
            else {
                await chmodp(file, 666);
                await unlinkp(file);
            }
            return true;
        }
        catch (e) {
            throw (LOG.error(e), e);
        }
    }));
    await chmodp(directory, 666);
    return await rmdirp(directory);
};

module.exports = deleteDirectory;
