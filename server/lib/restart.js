// Lets a route end the process so the supervising run-server.bat starts it again.
// There are up to two listeners (the local one and the phone bridge one); a restart closes all of them.
const httpServers = [];

export function registerServer(server) {
  if (!httpServers.includes(server)) httpServers.push(server);
}

export function requestRestart(code) {
  // Stop taking connections, then exit. Claude conversations do not end with the server: the runner (server/runner/index.js)
  // owns their processes and the next server takes them over again (runs.js). Processes the server started itself because no
  // runner was reachable, and jobs, are stopped by the exit handlers in runnerClient.js and jobs.js.
  for (const server of httpServers) {
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      // exiting anyway
    }
  }
  setTimeout(() => process.exit(code), 150);
}
