import { FunctionConfiguration } from "../models/projectConfiguration.js";

export interface FunctionHandlerProvider {
    write(
        outputPath: string,
        handlerFileName: string,
        functionConfiguration: FunctionConfiguration,
    ): Promise<void>;

    getLocalFunctionWrapperCode(
        handler: string,
        functionConfiguration: FunctionConfiguration,
    ): Promise<string>;
}
