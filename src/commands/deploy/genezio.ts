import { AxiosError } from "axios";
import { log } from "../../utils/logging.js";
import path from "path";
import { exit } from "process";
import {
    DASHBOARD_URL,
    RECOMMENTDED_GENEZIO_TYPES_VERSION_RANGE,
    REQUIRED_GENEZIO_TYPES_VERSION_RANGE,
} from "../../constants.js";
import { GENEZIO_NO_CLASSES_FOUND, UserError } from "../../errors.js";
import {
    mapYamlClassToSdkClassConfiguration,
    sdkGeneratorApiHandler,
} from "../../generateSdk/generateSdkApi.js";
import { FunctionConfiguration, ProjectConfiguration } from "../../models/projectConfiguration.js";
import { SdkHandlerResponse } from "../../models/sdkGeneratorResponse.js";
import { getNoMethodClasses } from "../../utils/getNoMethodClasses.js";
import {
    fileExists,
    createTemporaryFolder,
    zipDirectory,
    isDirectoryEmpty,
    directoryContainsIndexHtmlFiles,
    directoryContainsHtmlFiles,
    deleteFolder,
    getBundleFolderSizeLimit,
    readEnvironmentVariablesFile,
    zipFile,
    writeToFile,
} from "../../utils/file.js";
import { printAdaptiveLog, debugLogger, doAdaptiveLogAction } from "../../utils/logging.js";
import { GenezioCommand, reportSuccess, reportSuccessFunctions } from "../../utils/reporter.js";
import { generateRandomSubdomain } from "../../utils/yaml.js";
import cliProgress from "cli-progress";
import { YAMLBackend, YamlProjectConfiguration } from "../../yamlProjectConfiguration/v2.js";
import { GenezioCloudAdapter } from "../../cloudAdapter/genezio/genezioAdapter.js";
import { SelfHostedAwsAdapter } from "../../cloudAdapter/aws/selfHostedAwsAdapter.js";
import {
    CloudAdapter,
    GenezioCloudInput,
    GenezioCloudInputType,
    GenezioCloudOutput,
} from "../../cloudAdapter/cloudAdapter.js";
import { CloudProviderIdentifier } from "../../models/cloudProviderIdentifier.js";
import { GenezioDeployOptions } from "../../models/commandOptions.js";
import { GenezioTelemetry, TelemetryEventTypes } from "../../telemetry/telemetry.js";
import { setEnvironmentVariables } from "../../requests/setEnvironmentVariables.js";
import colors from "colors";
import { getEnvironmentVariables } from "../../requests/getEnvironmentVariables.js";
import { getProjectEnvFromProject } from "../../requests/getProjectInfo.js";
import { Status } from "../../requests/models.js";
import { bundle } from "../../bundlers/utils.js";
import {
    checkExperimentalDecorators,
    isDependencyVersionCompatible,
} from "../../utils/jsProjectChecker.js";
import { YamlConfigurationIOController } from "../../yamlProjectConfiguration/v2.js";
import { FunctionType, Language } from "../../yamlProjectConfiguration/models.js";
import { runScript } from "../../utils/scripts.js";
import { scanClassesForDecorators } from "../../utils/configuration.js";
import configIOController, { YamlFrontend } from "../../yamlProjectConfiguration/v2.js";
import { ClusterCloudAdapter } from "../../cloudAdapter/cluster/clusterAdapter.js";
import { writeSdk } from "../../generateSdk/sdkWriter/sdkWriter.js";
import { reportSuccessForSdk } from "../../generateSdk/sdkSuccessReport.js";
import { isLoggedIn } from "../../utils/accounts.js";
import { loginCommand } from "../login.js";
import { AwsFunctionHandlerProvider } from "../../functionHandlerProvider/providers/AwsFunctionHandlerProvider.js";
import fsExtra from "fs-extra/esm";
import { getLinkedFrontendsForProject } from "../../utils/linkDatabase.js";
import { getCloudProvider } from "../../requests/getCloudProvider.js";
import fs from "fs";

export async function genezioDeploy(
    options: GenezioDeployOptions,
    configuration: YamlProjectConfiguration,
) {
    const backendCwd = configuration.backend?.path || process.cwd();

    // We need to check if the user is using an older version of @genezio/types
    // because we migrated the decorators implemented in the @genezio/types package to the stage 3 implementation.
    // Otherwise, the user will get an error at runtime. This check can be removed in the future once no one is using version
    // 0.1.* of @genezio/types.
    if (
        configuration.backend?.language.name === Language.ts ||
        configuration.backend?.language.name === Language.js
    ) {
        const packageJsonPath = path.join(backendCwd, "package.json");
        if (
            isDependencyVersionCompatible(
                packageJsonPath,
                "@genezio/types",
                REQUIRED_GENEZIO_TYPES_VERSION_RANGE,
            ) === false
        ) {
            throw new UserError(
                `You are currently using an older version of @genezio/types, which is not compatible with this version of the genezio CLI. To solve this, please update the @genezio/types package on your backend component using the following command: npm install @genezio/types@${RECOMMENTDED_GENEZIO_TYPES_VERSION_RANGE}`,
            );
        }

        checkExperimentalDecorators(backendCwd);
    }

    // check if user is logged in
    if (!(await isLoggedIn())) {
        debugLogger.debug("No auth token found. Starting automatic authentication...");
        await loginCommand("", false);
    }

    let deployClassesResult;
    backend: if (configuration.backend && !options.frontend) {
        if (configuration.backend.classes?.length === 0) {
            log.error(
                "No classes were found in your genezio.yaml. Add some to be able to deploy your backend.",
            );
            break backend;
        }

        await doAdaptiveLogAction("Running backend deploy scripts", async () => {
            await runScript(configuration.backend?.scripts?.deploy, backendCwd);
        }).catch(async (error) => {
            await GenezioTelemetry.sendEvent({
                eventType: TelemetryEventTypes.GENEZIO_PRE_BACKEND_DEPLOY_SCRIPT_ERROR,
                commandOptions: JSON.stringify(options),
            });
            throw error;
        });

        await GenezioTelemetry.sendEvent({
            eventType: TelemetryEventTypes.GENEZIO_BACKEND_DEPLOY_START,
            commandOptions: JSON.stringify(options),
        });
        deployClassesResult = await deployClasses(configuration, options).catch(
            async (error: AxiosError<Status>) => {
                await GenezioTelemetry.sendEvent({
                    eventType: TelemetryEventTypes.GENEZIO_BACKEND_DEPLOY_ERROR,
                    errorTrace: error.toString(),
                    commandOptions: JSON.stringify(options),
                });
                throw error;
            },
        );
        await GenezioTelemetry.sendEvent({
            eventType: TelemetryEventTypes.GENEZIO_BACKEND_DEPLOY_END,
            commandOptions: JSON.stringify(options),
        });
    }

    const frontendUrls = [];
    if (configuration.frontend && !options.backend) {
        const frontends = configuration.frontend;

        for (const [index, frontend] of frontends.entries()) {
            try {
                await doAdaptiveLogAction(
                    `Running frontend ${index + 1} deploy script`,
                    async () => {
                        return await runScript(
                            frontend.scripts?.deploy,
                            frontend.path || process.cwd(),
                        );
                    },
                );
            } catch (error) {
                await GenezioTelemetry.sendEvent({
                    eventType: TelemetryEventTypes.GENEZIO_PRE_FRONTEND_DEPLOY_SCRIPT_ERROR,
                    commandOptions: JSON.stringify(options),
                });
                throw error;
            }

            await GenezioTelemetry.sendEvent({
                eventType: TelemetryEventTypes.GENEZIO_FRONTEND_DEPLOY_START,
                commandOptions: JSON.stringify(options),
            });

            log.info("Deploying your frontend to the genezio infrastructure...");
            const frontendUrl = await deployFrontend(
                configuration.name,
                configuration.region,
                frontend,
                index,
                options,
            ).catch(async (error) => {
                if (error instanceof Error) {
                    if (error.message == "No frontend entry in genezio configuration file.") {
                        log.error(error.message);
                        exit(0);
                    }
                    await GenezioTelemetry.sendEvent({
                        eventType: TelemetryEventTypes.GENEZIO_FRONTEND_DEPLOY_ERROR,
                        errorTrace: error.toString(),
                        commandOptions: JSON.stringify(options),
                    });
                    throw error;
                }
            });
            if (frontendUrl) frontendUrls.push(frontendUrl);

            await GenezioTelemetry.sendEvent({
                eventType: TelemetryEventTypes.GENEZIO_FRONTEND_DEPLOY_END,
                commandOptions: JSON.stringify(options),
            });
        }
    }
    if (deployClassesResult) {
        log.info(
            colors.cyan(
                `App Dashboard URL: ${DASHBOARD_URL}/project/${deployClassesResult.projectId}/${deployClassesResult.projectEnvId}`,
            ),
        );
    }
    for (const frontendUrl of frontendUrls) {
        log.info(colors.cyan(`Frontend URL: ${frontendUrl}`));
    }
}

export async function deployClasses(
    configuration: YamlProjectConfiguration,
    options: GenezioDeployOptions,
) {
    const backend: YAMLBackend = configuration.backend!;
    backend.classes = await scanClassesForDecorators(backend);

    if (backend.classes.length === 0 && backend.functions?.length === 0) {
        throw new UserError(GENEZIO_NO_CLASSES_FOUND(backend.language.name));
    }

    const sdkLanguages: Language[] = [];
    // Add configuration frontends that contain the SDK field
    sdkLanguages.push(
        ...((configuration.frontend || [])
            .map((f) => f.sdk?.language)
            .filter((f) => f !== undefined) as Language[]),
    );
    // Add linked frontends
    sdkLanguages.push(
        ...(await getLinkedFrontendsForProject(configuration.name)).map((f) => f.language),
    );

    const sdkResponse: SdkHandlerResponse = await sdkGeneratorApiHandler(
        sdkLanguages,
        mapYamlClassToSdkClassConfiguration(backend.classes, backend.language.name, backend.path),
        backend.path,
        /* packageName= */ `@genezio-sdk/${configuration.name}`,
    ).catch((error) => {
        // TODO: this is not very generic error handling. The SDK should throw Genezio errors, not babel.
        if (error.code === "BABEL_PARSER_SYNTAX_ERROR") {
            log.error("Syntax error:");
            log.error(`Reason Code: ${error.reasonCode}`);
            log.error(`File: ${error.path}:${error.loc.line}:${error.loc.column}`);
        }

        throw error;
    });
    const cloudProvider =
        // TODO: Remove this as soon as Genezio Cloud supports Go
        backend.language.name === Language.go
            ? CloudProviderIdentifier.GENEZIO_AWS
            : await getCloudProvider(configuration.name);
    const projectConfiguration = new ProjectConfiguration(
        configuration,
        cloudProvider,
        sdkResponse,
    );

    const classesWithNoMethods = getNoMethodClasses(projectConfiguration.classes);
    if (classesWithNoMethods.length) {
        const errorClasses = classesWithNoMethods.join(", ");
        throw new UserError(
            `Unable to deploy classes [${errorClasses}] as they do not have any methods.`,
        );
    }

    new cliProgress.MultiBar(
        {
            clearOnComplete: false,
            hideCursor: true,
            format: "Uploading {filename}: {bar} | {value}% | {eta_formatted}",
        },
        cliProgress.Presets.shades_grey,
    );

    printAdaptiveLog("Bundling your code\n", "start");
    const bundlerResult: Promise<GenezioCloudInput>[] = projectConfiguration.classes.map(
        async (element) => {
            const ast = sdkResponse.classesInfo.find(
                (classInfo) => classInfo.classConfiguration.path === element.path,
            )!.program;
            const output = await bundle(
                projectConfiguration,
                ast,
                element,
                options.installDeps,
                options.disableOptimization,
            );

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            // check if the unzipped folder is smaller than 250MB
            const unzippedBundleSize: number = await getBundleFolderSizeLimit(output.path);
            debugLogger.debug(
                `The unzippedBundleSize for class ${element.path} is ${unzippedBundleSize}.`,
            );

            // .jar files cannot be parsed by AWS Lambda, skip this step for AWS Lambda
            if (element.language === "kt") {
                debugLogger.debug("Skipping ZIP due to .jar file");
                debugLogger.debug(path.join(output.path, "app-standalone.jar"));
                return {
                    type: GenezioCloudInputType.CLASS,
                    name: element.name,
                    archivePath: path.join(output.path, "app-standalone.jar"),
                    filePath: element.path,
                    methods: element.methods,
                    unzippedBundleSize,
                    entryFile: output.extra.entryFile ?? "app-standalone.jar",
                };
            }

            const archivePathTempFolder = await createTemporaryFolder();
            const archivePath = path.join(archivePathTempFolder, `genezioDeploy.zip`);

            debugLogger.debug(`Zip the directory ${output.path}.`);
            if (element.language === "go") {
                await zipFile(path.join(output.path, "bootstrap"), archivePath);
            } else {
                await zipDirectory(output.path, archivePath);
            }

            await deleteFolder(output.path);

            return {
                type: GenezioCloudInputType.CLASS,
                name: element.name,
                archivePath: archivePath,
                filePath: element.path,
                methods: element.methods,
                dependenciesInfo: output.extra.dependenciesInfo,
                allNonJsFilesPaths: output.extra.allNonJsFilesPaths,
                unzippedBundleSize: unzippedBundleSize,
                entryFile: output.extra.entryFile ?? "",
            };
        },
    );

    const functionsResultArray: Promise<GenezioCloudInput>[] = projectConfiguration.functions.map(
        (f) => functionToCloudInput(f, backend.path),
    );

    const cloudAdapterDeployInput = await Promise.all([
        ...bundlerResult,
        ...functionsResultArray,
    ]).catch((error) => {
        printAdaptiveLog("Bundling your code\n", "error");
        throw error;
    });

    printAdaptiveLog("Bundling your code\n", "end");

    projectConfiguration.astSummary.classes = projectConfiguration.astSummary.classes.map((c) => {
        // remove cwd from path and the extension
        return {
            ...c,
            path: path.relative(process.cwd(), c.path).replace(/\.[^/.]+$/, ""),
        };
    });

    projectConfiguration.classes = projectConfiguration.classes.map((c) => {
        // remove cwd from path and the extension
        return {
            ...c,
            path: path.relative(process.cwd(), c.path).replace(/\.[^/.]+$/, ""),
        };
    });

    // TODO: Enable cloud adapter setting for every class
    const cloudAdapter = getCloudAdapter(cloudProvider);
    const result = await cloudAdapter.deploy(cloudAdapterDeployInput, projectConfiguration, {
        stage: options.stage,
    });

    if (
        sdkResponse.generatorResponses.length > 0 &&
        sdkResponse.generatorResponses[0].files.length <= 0
    ) {
        log.info(colors.cyan("Your backend code was successfully deployed!"));
        return;
    } else {
        log.info(
            colors.cyan(
                `Your backend code was ${result.classes.length > 0 ? "deployed and the SDK was successfully generated" : "successfully deployed"}`,
            ),
        );
    }
    if (result.classes.length > 0) {
        await handleSdk(configuration, result, sdkResponse, options);
        reportSuccess(result.classes);
    }

    if (result.functions.length > 0) {
        reportSuccessFunctions(result.functions);
    }

    const projectId = result.projectId;
    const projectEnvId = result.projectEnvId;
    if (projectId) {
        // Deploy environment variables if --upload-env is true
        if (options.env) {
            const envFile = path.join(process.cwd(), options.env);
            debugLogger.debug(`Loading environment variables from ${envFile}.`);

            if (!(await fileExists(envFile))) {
                // There is no need to exit the process here, as the project has been deployed
                log.error(`File ${envFile} does not exists. Please provide the correct path.`);
                await GenezioTelemetry.sendEvent({
                    eventType: TelemetryEventTypes.GENEZIO_DEPLOY_ERROR,
                    errorTrace: `File ${envFile} does not exists`,
                });
            } else {
                // Read environment variables from .env file
                const envVars = await readEnvironmentVariablesFile(envFile);
                const projectEnv = await getProjectEnvFromProject(projectId, options.stage);

                if (!projectEnv) {
                    throw new UserError("Project environment not found.");
                }

                // Upload environment variables to the project
                await setEnvironmentVariables(projectId, projectEnv.id, envVars)
                    .then(async () => {
                        debugLogger.debug(
                            `Environment variables from ${envFile} uploaded to project ${projectId}`,
                        );
                        log.info(
                            `The environment variables were uploaded to the project successfully.`,
                        );
                        await GenezioTelemetry.sendEvent({
                            eventType: TelemetryEventTypes.GENEZIO_DEPLOY_LOAD_ENV_VARS,
                        });
                    })
                    .catch(async (error: AxiosError) => {
                        log.error(`Loading environment variables failed with: ${error.message}`);
                        log.error(
                            `Try to set the environment variables using the dashboard ${colors.cyan(
                                DASHBOARD_URL,
                            )}`,
                        );
                        await GenezioTelemetry.sendEvent({
                            eventType: TelemetryEventTypes.GENEZIO_DEPLOY_ERROR,
                            errorTrace: error.toString(),
                        });
                    });
            }
        } else {
            const cwd = projectConfiguration.workspace?.backend
                ? path.resolve(projectConfiguration.workspace.backend)
                : process.cwd();
            const envFile = path.join(cwd, ".env");
            if (await fileExists(envFile)) {
                // read envVars from file
                const envVars = await readEnvironmentVariablesFile(envFile);
                const projectEnv = await getProjectEnvFromProject(projectId, options.stage);

                if (!projectEnv) {
                    throw new UserError("Project environment not found.");
                }

                // get remoteEnvVars from project
                const remoteEnvVars = await getEnvironmentVariables(projectId, projectEnv.id);

                // check if all envVars from file are in remoteEnvVars
                const missingEnvVars = envVars.filter(
                    (envVar) =>
                        !remoteEnvVars.find((remoteEnvVar) => remoteEnvVar.name === envVar.name),
                );

                // Print missing env vars
                if (missingEnvVars.length > 0) {
                    log.info(
                        `${colors.yellow(
                            "Warning: The following environment variables are not set on your project: ",
                        )}`,
                    );
                    missingEnvVars.forEach((envVar) => {
                        log.info(`${colors.yellow(envVar.name)}`);
                    });

                    const relativeEnvFilePath = path.join(
                        ".",
                        path.relative(path.resolve(process.cwd()), path.resolve(envFile)),
                    );

                    log.info("");
                    log.info(
                        `${colors.yellow("Go to the dashboard ")}${colors.cyan(
                            DASHBOARD_URL,
                        )} ${colors.yellow(
                            "to set your environment variables or run ",
                        )} ${colors.cyan(`genezio deploy --env ${relativeEnvFilePath}`)}`,
                    );
                    log.info("");
                }
            }
        }

        return {
            projectId: projectId,
            projectEnvId: projectEnvId,
        };
    }
}

export async function functionToCloudInput(
    functionElement: FunctionConfiguration,
    backendPath: string,
): Promise<GenezioCloudInput> {
    if (functionElement.language !== "js" && functionElement.language !== "ts") {
        throw new UserError(
            `The language ${functionElement.language} is not supported for functions. Only JavaScript and TypeScript are supported.`,
        );
    }
    const handlerProvider = getFunctionHandlerProvider(functionElement.type);

    const handlerContent = await handlerProvider.getHandler(functionElement);

    // create temporary folder
    const tmpFolderPath = await createTemporaryFolder();
    const archivePath = path.join(await createTemporaryFolder(), `genezioDeploy.zip`);

    // copy everything to the temporary folder
    await fsExtra.copy(path.join(backendPath, functionElement.path), tmpFolderPath);

    const unzippedBundleSize = await getBundleFolderSizeLimit(tmpFolderPath);

    // add the handler to the temporary folder
    // check if there already is an index.mjs file in user's code
    let entryFile = "index.mjs";
    while (fs.existsSync(path.join(tmpFolderPath, entryFile))) {
        debugLogger.debug(
            `[FUNCTION ${functionElement.name}] File ${entryFile} already exists in the temporary folder.`,
        );
        entryFile = `index-${Math.random().toString(36).substring(7)}.mjs`;
    }
    await writeToFile(path.join(tmpFolderPath), entryFile, handlerContent);

    debugLogger.debug(`Zip the directory ${tmpFolderPath}.`);

    // zip the temporary folder
    await zipDirectory(tmpFolderPath, archivePath);

    debugLogger.debug(`Zip created at path: ${archivePath}.`);

    await deleteFolder(tmpFolderPath);

    return {
        type: GenezioCloudInputType.FUNCTION as GenezioCloudInputType.FUNCTION,
        name: functionElement.name,
        archivePath: archivePath,
        unzippedBundleSize: unzippedBundleSize,
        entryFile,
    };
}

export async function deployFrontend(
    name: string,
    region: string,
    frontend: YamlFrontend,
    index: number,
    options: GenezioDeployOptions,
): Promise<string | undefined> {
    const stage: string = options.stage || "";

    if (!frontend.publish) {
        log.info(
            `Skipping frontend deployment for \`${frontend.path}\` because it has no publish folder in the YAML configuration. Check https://genezio.com/docs/project-structure/genezio-configuration-file for more details.`,
        );

        return;
    }

    try {
        await doAdaptiveLogAction(`Building frontend ${index + 1}`, async () => {
            await runScript(frontend.scripts?.build, frontend.path);
        });
    } catch (error) {
        if (error instanceof Error) log.error(new Error(error.message));
        log.info(`Skipping frontend ${index + 1} deployment because the build script failed.`);
        return;
    }

    // check if subdomain contains only numbers, letters and hyphens
    if (frontend.subdomain && !frontend.subdomain.match(/^[a-z0-9-]+$/)) {
        throw new UserError(`The subdomain can only contain letters, numbers and hyphens.`);
    }

    // check if the publish folder exists
    const frontendPath = path.join(frontend.path, frontend.publish);
    if (!(await fileExists(frontendPath))) {
        throw new UserError(
            `The publish folder ${colors.cyan(
                `${frontendPath}`,
            )} does not exist. Please run the build command first or add a \`deploy\` script in the genezio.yaml file.`,
        );
    }

    // check if the publish folder is empty
    if (await isDirectoryEmpty(frontendPath)) {
        throw new UserError(
            `The publish folder ${colors.cyan(
                `${frontendPath}`,
            )} is empty. Please run the build command first or add a \`deploy\` script in the genezio.yaml file.`,
        );
    }

    // check if there are any .html files in the publish folder
    if (!(await directoryContainsHtmlFiles(frontendPath))) {
        log.info("WARNING: No .html files found in the publish folder");
    } else if (!(await directoryContainsIndexHtmlFiles(frontendPath))) {
        // check if there is no index.html file in the publish folder
        log.info("WARNING: No index.html file found in the publish folder");
    }

    if (!options.subdomain && !frontend.subdomain) {
        log.info(
            "No subdomain specified in the genezio.yaml configuration file or as an option flag. We will provide a random one for you.",
        );

        // write the configuration in yaml file
        const yamlConfigIOController = new YamlConfigurationIOController(options.config);
        const yamlConfig = await yamlConfigIOController.read(/* fillDefaults= */ false);

        if (yamlConfig.frontend) {
            const subdomain = generateRandomSubdomain();

            if (Array.isArray(yamlConfig.frontend)) {
                yamlConfig.frontend[index].subdomain = subdomain;
            } else {
                yamlConfig.frontend.subdomain = subdomain;
            }

            frontend.subdomain = subdomain;
        } else {
            throw new UserError("No frontend entry in genezio configuration file.");
        }

        await configIOController.write(yamlConfig);
    }

    frontend.subdomain = options.subdomain || frontend.subdomain;

    const cloudAdapter = getCloudAdapter(CloudProviderIdentifier.GENEZIO_CLOUD);
    const url = await cloudAdapter.deployFrontend(name, region, frontend, stage);
    return url;
}

async function handleSdk(
    configuration: YamlProjectConfiguration,
    result: GenezioCloudOutput,
    sdk: SdkHandlerResponse,
    options: GenezioDeployOptions,
) {
    const frontends = configuration.frontend;

    const sdkLocations: Array<{ path: string; language: Language }> = [];

    for (const frontend of frontends || []) {
        if (frontend.sdk) {
            sdkLocations.push({
                path: path.join(frontend.path, frontend.sdk.path || "sdk"),
                language: frontend.sdk.language,
            });
        }
    }

    const linkedFrontends = await getLinkedFrontendsForProject(configuration.name);
    linkedFrontends.forEach((f) =>
        sdkLocations.push({
            path: f.path,
            language: f.language,
        }),
    );

    for (const sdkLocation of sdkLocations) {
        const sdkResponse = sdk.generatorResponses.find(
            (response) => response.sdkGeneratorInput.language === sdkLocation.language,
        );

        if (!sdkResponse) {
            throw new UserError("Could not find the SDK for the frontend.");
        }

        const classUrls = result.classes.map((c) => ({
            name: c.className,
            cloudUrl: c.functionUrl,
        }));
        await writeSdk({
            language: sdkLocation.language,
            packageName: `@genezio-sdk/${configuration.name}`,
            packageVersion: `1.0.0-${options.stage}`,
            sdkResponse,
            classUrls,
            publish: true,
            installPackage: true,
            outputPath: sdkLocation.path,
        });

        reportSuccessForSdk(sdkLocation.language, sdkResponse, GenezioCommand.deploy, {
            name: configuration.name,
            stage: options.stage || "prod",
        });
    }
}

export function getCloudAdapter(provider: CloudProviderIdentifier): CloudAdapter {
    switch (provider) {
        case CloudProviderIdentifier.GENEZIO_AWS:
        case CloudProviderIdentifier.GENEZIO_UNIKERNEL:
            return new GenezioCloudAdapter();
        case CloudProviderIdentifier.GENEZIO_CLOUD:
            return new GenezioCloudAdapter();
        case CloudProviderIdentifier.GENEZIO_CLUSTER:
            return new ClusterCloudAdapter();
        case CloudProviderIdentifier.SELF_HOSTED_AWS:
            return new SelfHostedAwsAdapter();
        default:
            throw new UserError(`Unsupported cloud provider: ${provider}`);
    }
}

export function getFunctionHandlerProvider(functionType: FunctionType): AwsFunctionHandlerProvider {
    switch (functionType) {
        case FunctionType.aws:
            return new AwsFunctionHandlerProvider();
        default:
            throw new UserError(
                `Unsupported function type: ${functionType}. Supported providers are: aws`,
            );
    }
}
