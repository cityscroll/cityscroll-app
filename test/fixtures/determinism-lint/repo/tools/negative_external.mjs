export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--check")) {
    return run("--from-live");
  }
  return null;
}

function run(flag) {
  return flag;
}
