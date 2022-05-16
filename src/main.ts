import { getInput, info, setFailed, setOutput } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { NxJsonConfiguration, WorkspaceJsonConfiguration } from '@nrwl/devkit';
import * as nx from '@nrwl/workspace';
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
  ignore: string[];
}

const getBaseAndHeadRefs = ({
  base,
  head,
  ignore
}: {
  base: string;
  head: string;
  ignore: string;
}): Refs => {
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

  let parsedIgnore: string[] = [];

  try {
    const tmp = JSON.parse(ignore);

    if (Array.isArray(tmp)) {
      parsedIgnore = tmp;
    }
  } catch {
    info(`Ignore input "${ignore}" can not be parsed`);
  }

  if (!base || !head) {
    throw new Error(`Base or head refs are missing`);
  }

  info(`Base ref: ${base}`);
  info(`Head ref: ${head}`);
  info(`Ignore ref: [${parsedIgnore.join(',')}]`);

  return {
    base,
    head,
    ignore: parsedIgnore
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

const readNx = (): { nx: NxJsonConfiguration; workspace: WorkspaceJsonConfiguration } => {
  return {
    nx: nx.readNxJson(),
    workspace: nx.readWorkspaceJson()
  };
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
  changedFiles,
  ignore
}: {
  appsDir: string;
  libsDir: string;
  allApps: string[];
  allLibs: string[];
  implicitDependencies: any[];
  changedFiles: string[];
  ignore: string[];
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
        accumulatedChanges.implicitDependencies.push(implicitDependency.file);
        allApps.forEach(app => accumulatedChanges.apps.add(app.split('/').slice(-1)[0]));
        allLibs.forEach(lib => accumulatedChanges.libs.add(lib.split('/').slice(-1)[0]));
      }

      const lib = findLib(file);
      if (lib) {
        const libName = lib.split('/').slice(-1)[0];

        accumulatedChanges.libs.add(lib.split('/').slice(-1)[0]);
        const projects = implicitDependencies.find(dependency => dependency.key === libName)
          ?.projects;

        projects &&
          [...projects].forEach((project: string) => {
            if (allApps.includes(project)) {
              accumulatedChanges.apps.add(project.split('/').slice(-1)[0]);
            }

            if (allLibs.includes(project)) {
              accumulatedChanges.libs.add(project.split('/').slice(-1)[0]);
            }
          });
      }

      const app = findApp(file);
      if (app) {
        accumulatedChanges.apps.add(app.split('/').slice(-1)[0]);
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
    apps: [...changes.apps.values()].filter(name => !ignore.includes(name)),
    libs: [...changes.libs.values()],
    implicitDependencies: changes.implicitDependencies
  };
};

const main = async () => {
  const token = process.env.GITHUB_TOKEN;
  const octokit = getOctokit(token as string);

  const { base, head, ignore } = getBaseAndHeadRefs({
    base: getInput('baseRef'),
    head: getInput('headRef'),
    ignore: getInput('ignore')
  });

  info('1');

  const changedFiles = await getChangedFiles(octokit, base, head);

  info('2');

  const { nx, workspace } = readNx();
  info(JSON.stringify(nx));
  info(JSON.stringify(workspace));

  const implicitDependencies = Object.keys(nx.implicitDependencies || {})
    .map(file => ({ file }))
    .concat(
      Object.entries(workspace.projects).reduce((result: any[], [name, project]) => {
        info('loop');

        const implicitDependencies = project?.implicitDependencies || [];

        implicitDependencies.forEach(key => {
          info('loop key');
          let lib = result.find(item => item.key === key);

          if (!lib) {
            lib = { key, projects: new Set() };
            result.push(lib);
          }

          lib.projects.add(name);
        });

        return result;
      }, [])
    );

  info('3');

  const appsDir = nx.workspaceLayout?.appsDir || 'apps';
  const libsDir = nx.workspaceLayout?.libsDir || 'libs';
  const allApps = (await fs.readdir(appsDir)).filter(name => name[0] !== '.');
  const allLibs = (await fs.readdir(libsDir)).filter(name => name[0] !== '.');

  info('4');

  const changes = getChanges({
    appsDir,
    libsDir,
    allApps,
    allLibs,
    implicitDependencies,
    changedFiles,
    ignore
  });

  console.log('changed apps:');
  console.log(changes.apps);

  console.log('changed libs:');
  console.log(changes.libs);

  console.log('changed implicit dependencies:');
  console.log(changes.implicitDependencies);

  setOutput('changed-apps-matrix', JSON.stringify(changes.apps));
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
