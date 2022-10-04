import { Env, Remote } from "./remote.js"

export class User {
    static remote = new Remote(undefined)

    static async constructor() {
        return User.remote.call("User.constructor")  
    }
    
    static async connect() {
        return User.remote.call("User.connect")  
    }
    
    static async create(name, email, password) {
        return User.remote.call("User.create", name, email, password)  
    }

    static async login(email, password) {
        return User.remote.call("User.login", email, password)  
    }

    static async register(name, email, password) {
        return User.remote.call("User.register", name, email, password)  
    }

    
}

export { Env, Remote };
