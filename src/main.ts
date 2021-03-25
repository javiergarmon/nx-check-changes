import { getInput, info, setFailed, setOutput } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { NxJson } from '@nrwl/workspace';
import { promises as fs } from 'fs';

type OctoKit = ReturnType<typeof getOctokit>;

interface Changes {
  apps: string[];
  libs: string[];
  implicitDependencies: string[];
}

interface Refs {
  base: string;
  head: string;
}

const getBaseAndHeadRefs = ({ base, head }: Partial<Refs>): Refs => {
  switch (context.eventName) {
    case 'pull_request':
      base = context.payload.pull_request?.base?.sha as string;
      head = context.payload.pull_request?.head?.sha as string;
      break;
    case 'push':
      base = context.payload.before as string;
      head = context.payload.after as string;
      break;
    default:
      if (!base || !head) {
        throw new Error(`Missing 'base' or 'head' refs for event type '${context.eventName}'`);
      }
  }

  if (!base || !head) {
    throw new Error(`Base or head refs are missing`);
  }

  info(`Base ref: ${base}`);
  info(`Head ref: ${head}`);

  return {
    base,
    head
  };
};

const getChangedFiles = async (octokit: OctoKit, base: string, head: string): Promise<string[]> => {
  const response = await octokit.repos.compareCommits({
    base,
    head,
    owner: context.repo.owner,
    repo: context.repo.repo
  });

  const files = response.data.files;

  return files.map(file => file.filename);
};

const readNxFile = async (): Promise<NxJson> => {
  const nxFile = await fs.readFile('nx.json', { encoding: 'utf-8' });
  return JSON.parse(nxFile) as NxJson;
};

const dirFinder = (dir: string) => {
  const pathRegExp = new RegExp(`(${dir}\\/[^/]+)\\/.+`);
  return (file: string) => file.match(pathRegExp)?.[1];
};

const getChanges = ({
  appsDir,
  libsDir,
  allApps,
  allLibs,
  implicitDependencies,
  changedFiles
}: {
  appsDir: string;
  libsDir: string;
  allApps: string[];
  allLibs: string[];
  implicitDependencies: any[];
  changedFiles: string[];
}): Changes => {
  const findApp = dirFinder(appsDir);
  const findLib = dirFinder(libsDir);
  const findImplicitDependencies = (file: string) =>
    implicitDependencies.find(dependency => file === dependency.file);

  const changes = changedFiles.reduce<{
    apps: Set<string>;
    libs: Set<string>;
    implicitDependencies: string[];
  }>(
    (accumulatedChanges, file) => {
      const implicitDependency = findImplicitDependencies(file);
      if (implicitDependency) {
        accumulatedChanges.implicitDependencies.push(implicitDependency);
        allApps.forEach(app => accumulatedChanges.apps.add(app))
        allLibs.forEach(lib => accumulatedChanges.libs.add(lib))
      }

      const lib = findLib(file);
      if (lib) {
        const libName = lib.slice(libsDir.length + 1)

        accumulatedChanges.libs.add(lib);
        const projects = implicitDependencies.find(dependency => dependency.key === libName)?.projects

        projects && [...projects].forEach((project: string) => {
          if(allApps.includes(project)){
            accumulatedChanges.apps.add(project)
          }

          if(allLibs.includes(project)){
            accumulatedChanges.libs.add(project)
          }
        })
      }

      const app = findApp(file);
      if (app) {
        accumulatedChanges.apps.add(app);
      }

      return accumulatedChanges;
    },
    {
      apps: new Set<string>(),
      libs: new Set<string>(),
      implicitDependencies: []
    }
  );

  return {
    apps: [...changes.apps.values()],
    libs: [...changes.libs.values()],
    implicitDependencies: changes.implicitDependencies
  };
};

const main = async () => {
  const token = process.env.GITHUB_TOKEN;

  const octokit = getOctokit(token as string);

  const { base, head } = getBaseAndHeadRefs({
    base: getInput('baseRef'),
    head: getInput('headRef')
  });

  const changedFiles = await getChangedFiles(octokit, base, head);
  const nxFile = await readNxFile();
  const implicitDependencies = Object.keys(nxFile.implicitDependencies || {})
    .map(file => ({file, target: '*'}))
    .concat(
      Object.entries(nxFile.projects).reduce((result: any[], [name, project]) => {
        const implicitDependencies = project?.implicitDependencies || []

        implicitDependencies.forEach(key => {
          let lib = result.find(item => item.key === key)

          if(!lib){
            lib = {key, projects: new Set()}
            result.push(lib)
          }

          lib.projects.add(name)
        })

        return result
      }, [])
    )

  const appsDir = nxFile.workspaceLayout?.appsDir || 'apps';
  const libsDir = nxFile.workspaceLayout?.libsDir || 'libs';

  const allApps = (await fs.readdir(appsDir)).filter(name => name[0] !== '.');
  const allLibs = (await fs.readdir(libsDir)).filter(name => name[0] !== '.');
  console.log(allApps)
  console.log(allLibs)

  const changes = getChanges({
    appsDir,
    libsDir,
    allApps,
    allLibs,
    implicitDependencies,
    changedFiles
  });

  console.log('changed apps:');
  console.log(changes.apps);

  console.log('changed libs:');
  console.log(changes.libs);

  console.log('changed implicit dependencies:');
  console.log(changes.implicitDependencies);

  setOutput('changed-apps-matrix', JSON.stringify(changes));
  setOutput('changed-apps', changes.apps.join(' '));
  setOutput('changed-libs', changes.libs.join(' '));
  setOutput('changed-dirs', [...changes.apps, ...changes.libs].join(' '));
  setOutput('changed-implicit-dependencies', changes.implicitDependencies.join(' '));
  setOutput(
    'not-affected',
    changes.apps.length === 0 &&
      changes.libs.length === 0 &&
      changes.implicitDependencies.length === 0
  );
};

main().catch(error => setFailed(error));
