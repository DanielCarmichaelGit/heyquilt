// A child process's environment with its home folder at `dir`. os.homedir() reads HOME on
// macOS and Linux but USERPROFILE on Windows: set only HOME and, on Windows, the child
// would read and write the real ~/.quilt of whoever runs the tests.
export function homeEnv (dir, extra = {}) {
  return { ...process.env, HOME: dir, USERPROFILE: dir, ...extra }
}
