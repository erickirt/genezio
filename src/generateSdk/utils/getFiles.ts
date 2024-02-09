import { YamlProjectConfiguration } from "../../models/yamlProjectConfiguration.js";
import fs from "fs";
import { AstGeneratorInput } from "../../models/genezioModels.js";

export function getGenerateAstInputs(
    projectConfiguration: YamlProjectConfiguration,
): AstGeneratorInput[] {
    const getGenerateAstInputs: AstGeneratorInput[] = [];

    for (const classFile of projectConfiguration.classes) {
        // read file from classFile.path
        const data = fs.readFileSync(classFile.path, "utf-8");

        getGenerateAstInputs.push({
            class: {
                path: classFile.path,
                data,
                name: classFile.name,
            },
            root: projectConfiguration.workspace?.backend,
        });
    }

    return getGenerateAstInputs;
}
