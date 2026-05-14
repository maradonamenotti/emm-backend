import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppUser } from '../entities/AppUser';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(AppUser)
    private usersRepository: Repository<AppUser>,
  ) {}

  async findOneByEmail(email: string): Promise<AppUser | null> {
    return this.usersRepository.findOneBy({ email: email.trim().toLowerCase() });
  }

  async findAll(): Promise<AppUser[]> {
    return this.usersRepository.find();
  }

  async create(userData: Partial<AppUser>): Promise<AppUser> {
    const existing = await this.findOneByEmail(userData.email!);
    if (existing) {
      throw new BadRequestException({ error: 'El usuario ya existe' });
    }
    const user = this.usersRepository.create(userData);
    return this.usersRepository.save(user);
  }

  async update(id: string, userData: Partial<AppUser>): Promise<AppUser> {
    const user = await this.usersRepository.findOneBy({ id });
    if (!user) {
      throw new NotFoundException({ error: 'Usuario no encontrado' });
    }
    Object.assign(user, userData);
    return this.usersRepository.save(user);
  }

  async delete(id: string): Promise<void> {
    await this.usersRepository.delete(id);
  }
}
